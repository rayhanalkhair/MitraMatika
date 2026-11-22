import type { TokenBudget } from "./budget";
import { checkImages } from "./images";
import {
  AiOutputError,
  AiPolicyError,
  AiQuotaError,
  type AiCompleteOptions,
  type AiProvider,
  type AiUsage,
  type GatewayRequest,
  type GatewayResult,
  type RouteEntry,
  type RoutingConfig,
} from "./types";

export { MAX_IMAGES_BASE64_CHARS, MAX_IMAGES_PER_REQUEST } from "./images";

const DEFAULT_MAX_OUTPUT_TOKENS = 2000;

// The highest hard output cap sent to a provider for a route without its own cap.
export const PROVIDER_CAP_CEILING = 16_000;

// The provider always gets a hard cap. On a paced route it is exactly the output slot booked
// (the reservation, already clamped to the route's cap), so the per-minute limit holds. Elsewhere
// it is decoupled from the reservation: three times it, within the route's cap or the ceiling.
// The reservation is an estimate real answers exceed (gpt-oss reasoning: up to 847 output tokens
// for a 700-token question), so it must not truncate; usage beyond it is recorded after the call.
function providerCapFor(route: RouteEntry, reservation: number): number {
  if (route.otpm !== undefined) return Math.min(route.maxOutputTokens, reservation);
  return Math.min(
    route.maxOutputTokens ?? PROVIDER_CAP_CEILING,
    Math.ceil(reservation * 3),
  );
}

// A paced route without an output cap at or below its limit would defer every call: refuse it.
function checkRouting(routing: RoutingConfig): void {
  for (const [task, routes] of Object.entries(routing)) {
    for (const route of routes) {
      if (route.otpm === undefined) continue;
      const cap = route.maxOutputTokens as number | undefined;
      if (cap === undefined || cap > route.otpm) {
        throw new Error(
          `Route ${route.model} for ${task} has otpm ${String(route.otpm)} and must set ` +
            "maxOutputTokens at or below it.",
        );
      }
    }
  }
}

// What a request may reserve on a route: the caller's figure, never above the route's cap.
function outputCapFor(route: RouteEntry, requested: number | undefined): number {
  const wanted = requested ?? route.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return route.maxOutputTokens === undefined
    ? wanted
    : Math.min(wanted, route.maxOutputTokens);
}

// Books the call's cost (and its output slot on a paced route) atomically, waiting for the slot
// when that is short and ends before the caller's deadline; false means defer.
function book(
  budget: TokenBudget,
  route: RouteEntry,
  cost: number,
  maxOutputTokens: number,
  deadline: number | undefined,
): Promise<boolean> {
  return budget.book(route.model, cost, {
    ...(route.otpm !== undefined
      ? { output: { tokens: maxOutputTokens, otpm: route.otpm } }
      : {}),
    deadline,
  });
}

// A call may use more than it booked (input over its estimate, output over its reservation):
// book each overrun on its own, so slack on one side never hides an overrun on the other.
function recordBeyondReservation(
  budget: TokenBudget,
  route: RouteEntry,
  bookedInput: number,
  bookedOutput: number,
  usage: AiUsage,
): void {
  const extraInput = Math.max(0, usage.inputTokens - bookedInput);
  const extraOutput = Math.max(0, usage.outputTokens - bookedOutput);
  if (extraInput + extraOutput > 0) budget.record(route.model, extraInput + extraOutput);
  if (route.otpm !== undefined && extraOutput > 0) {
    budget.recordOutput(route.model, extraOutput);
  }
}

export interface GatewayOptions {
  routing: RoutingConfig;
  providers: Record<string, AiProvider>;
  budget: TokenBudget;
}

async function callWithRepair<T>(
  provider: AiProvider,
  route: RouteEntry,
  request: GatewayRequest<T>,
  budget: TokenBudget,
  maxOutputTokens: number,
  cost: number,
): Promise<GatewayResult<T>> {
  let prompt = request.prompt;
  let lastError = "";
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const images = request.images ?? [];
  // Only images and a route's own cap reach the provider; other calls keep the three-argument form.
  const options: AiCompleteOptions = {
    ...(images.length > 0 ? { images } : {}),
    maxOutputTokens: providerCapFor(route, maxOutputTokens),
  };
  let booked = cost;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Before the retry (attempt 2), check if we have budget for the longer prompt
    if (attempt === 1) {
      const retryCost =
        budget.estimate(request.system + prompt, images.length) + maxOutputTokens;
      booked = retryCost;
      if (!(await book(budget, route, retryCost, maxOutputTokens, request.deadline))) {
        throw new AiQuotaError(
          "Kuota AI habis sebelum perbaikan keluaran; pekerjaan ditunda.",
        );
      }
    }

    const completion = await provider.complete(
      route.model,
      request.system,
      prompt,
      options,
    );
    if (completion.usage) {
      recordBeyondReservation(
        budget,
        route,
        booked - maxOutputTokens,
        maxOutputTokens,
        completion.usage,
      );
      usage.inputTokens += completion.usage.inputTokens;
      usage.outputTokens += completion.usage.outputTokens;
      if (completion.usage.cachedTokens !== undefined) {
        usage.cachedTokens = (usage.cachedTokens ?? 0) + completion.usage.cachedTokens;
      }
      request.onUsage?.(completion.usage);
    }
    try {
      const value = request.parse(JSON.parse(completion.text));
      return {
        value,
        provider: provider.name,
        model: route.model,
        usage,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      prompt =
        `${request.prompt}\n\nKeluaran sebelumnya tidak valid: ${lastError}. ` +
        "Kembalikan hanya JSON yang valid.";
    }
  }
  throw new AiOutputError(lastError);
}

/**
 * The only way application code reaches an AI provider. `generate` refuses student data (class
 * C3) and unsendable images before anything leaves, picks the first route whose data class allows
 * the request (and that takes images, when the request has some) and whose model budget has room,
 * waiting up to 70 s (never past the request's deadline) for a paced model's output-per-minute
 * window, and parses the output with the
 * caller's `parse`, repairing once. Throws `AiPolicyError`, `AiImageError`, `AiQuotaError`,
 * `AiOutputError` or `AiProviderError`; the job layer maps them.
 */
export function createGateway({ routing, providers, budget }: GatewayOptions) {
  checkRouting(routing);
  return {
    async generate<T>(request: GatewayRequest<T>): Promise<GatewayResult<T>> {
      if (request.dataClass === "C3") {
        throw new AiPolicyError(
          "student_data_blocked",
          "Data pribadi siswa tidak boleh dikirim ke penyedia AI.",
        );
      }

      const images = request.images ?? [];
      checkImages(images);

      const eligible = (routing[request.task] ?? []).filter(
        (route) =>
          route.allowedDataClasses.includes(request.dataClass) &&
          // Images are teacher material (C2) whatever class the caller declared.
          (images.length === 0 ||
            (route.vision === true && route.allowedDataClasses.includes("C2"))),
      );
      if (eligible.length === 0) {
        throw new AiPolicyError(
          "no_eligible_route",
          `Tidak ada rute AI untuk tugas ${request.task} dengan kelas data ${request.dataClass}.`,
        );
      }

      const inputCost = budget.estimate(request.system + request.prompt, images.length);

      for (const route of eligible) {
        const maxOutputTokens = outputCapFor(route, request.maxOutputTokens);
        const cost = inputCost + maxOutputTokens;
        if (!budget.canSpend(route.model, cost)) continue;
        const provider = providers[route.provider] as AiProvider | undefined;
        if (!provider) {
          throw new Error(`Unknown provider "${route.provider}" in routing table.`);
        }
        if (!(await book(budget, route, cost, maxOutputTokens, request.deadline)))
          continue;
        return callWithRepair(provider, route, request, budget, maxOutputTokens, cost);
      }

      throw new AiQuotaError(
        "Kuota AI habis untuk semua rute yang diizinkan; pekerjaan ditunda.",
      );
    },
  };
}
