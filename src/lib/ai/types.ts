export type DataClass = "C0" | "C1" | "C2" | "C3";

export const AI_TASKS = [
  "generate_questions",
  "regenerate_question",
  "solve_independent",
  "ocr_page",
  "parse_request",
  "propose_structure",
  "solve_problem",
  "alternative_method",
] as const;

export type AiTask = (typeof AI_TASKS)[number];

interface RouteBase {
  provider: string;
  model: string;
  // The plan's "allowedPrivacyClasses" (ruling R1): only these data classes may use this route.
  allowedDataClasses: DataClass[];
  // The model accepts image input; a request carrying images only uses routes that say so, and
  // only when they allow C2 (images are always teacher material).
  vision?: boolean;
  // The most output a request may reserve on this route; the request's figure is clamped to it.
  maxOutputTokens?: number;
}

// A paced route (output tokens per minute the provider allows for this model) must cap its
// output at or below that limit: `createGateway` refuses a table that does not.
export type RouteEntry =
  | (RouteBase & { otpm?: undefined })
  | (RouteBase & { otpm: number; maxOutputTokens: number });

// A task missing from the table has no route (the gateway answers "no eligible route").
export type RoutingConfig = Partial<Record<AiTask, RouteEntry[]>>;

export type AiImageMime = "image/png" | "image/jpeg";

export interface AiImage {
  mime: AiImageMime;
  base64: string;
}

export interface AiCompleteOptions {
  images?: AiImage[];
  maxOutputTokens?: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface AiCompletion {
  text: string;
  usage?: AiUsage;
}

export interface AiProvider {
  name: string;
  complete(
    model: string,
    system: string,
    prompt: string,
    options?: AiCompleteOptions,
  ): Promise<AiCompletion>;
}

export interface GatewayRequest<T> {
  task: AiTask;
  dataClass: DataClass;
  system: string;
  prompt: string;
  parse: (raw: unknown) => T;
  // Page or photo images sent with the prompt; only routes marked `vision` receive them.
  images?: AiImage[];
  maxOutputTokens?: number;
  // The latest time (ms, on the budget's clock) the gateway may still be waiting for a paced
  // model; a wait that would end later defers the work instead (the job's own deadline).
  deadline?: number;
  // Called after every successful provider call, including one whose output is then rejected, so a
  // caller can account for the tokens even when generate() throws.
  onUsage?: (usage: AiUsage) => void;
}

export interface GatewayResult<T> {
  value: T;
  provider: string;
  model: string;
  // Summed over the attempts; zeros when the provider reported none.
  usage: AiUsage;
  attempts: number;
}

export class AiPolicyError extends Error {
  constructor(
    public readonly code: "student_data_blocked" | "no_eligible_route",
    message: string,
  ) {
    super(message);
    this.name = "AiPolicyError";
  }
}

export class AiQuotaError extends Error {
  public readonly code = "quota_deferred" as const;
  constructor(message: string) {
    super(message);
    this.name = "AiQuotaError";
  }
}

export class AiOutputError extends Error {
  public readonly code = "invalid_output" as const;
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

// An image the gateway or a provider cannot send: too large, of another type, or to a provider
// without image input. Raised before anything leaves; images are never silently dropped.
export class AiImageError extends Error {
  constructor(
    public readonly code:
      | "images_unsupported"
      | "image_too_large"
      | "image_type_unsupported"
      | "image_invalid"
      | "too_many_images",
    message: string,
  ) {
    super(message);
    this.name = "AiImageError";
  }
}

export type AiProviderErrorKind =
  "rate_limited" | "unavailable" | "auth_failed" | "timeout" | "invalid_response";

// A failure of the provider itself (not of the model's output). The message is a fixed Indonesian
// sentence; `detail` keeps the technical text for the provider's own call logger only.
export class AiProviderError extends Error {
  public readonly code = "provider_error" as const;
  public readonly kind: AiProviderErrorKind;
  public readonly status: number | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly detail: string | undefined;

  constructor(
    kind: AiProviderErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = "AiProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }
}
