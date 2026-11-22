import { getEnv, type Env } from "../env";
import { TokenBudget } from "./budget";
import { isFakeAiEnabled } from "./e2e/control";
import { createScriptedProvider } from "./e2e/scripted-provider";
import { createGateway } from "./gateway";
import { createGeminiProvider } from "./providers/gemini";
import { createGroqProvider } from "./providers/groq";
import { defaultRouting } from "./routing.config";
import {
  AI_TASKS,
  type AiProvider,
  type AiTask,
  type RouteEntry,
  type RoutingConfig,
} from "./types";

/**
 * One provider per API key that is configured. A missing key means that provider is simply absent.
 * With the e2e seam on (E2E_FAKE_AI=1, never in production) both names are scripted providers and
 * the keys are ignored; `processEnv` is only injectable so the gate can be tested.
 */
export function createRuntimeProviders(
  env: Pick<Env, "GROQ_API_KEY" | "GOOGLE_API_KEY">,
  processEnv: Record<string, string | undefined> = process.env,
): Record<string, AiProvider> {
  if (isFakeAiEnabled(processEnv)) {
    return {
      groq: createScriptedProvider("groq"),
      gemini: createScriptedProvider("gemini"),
    };
  }
  const providers: Record<string, AiProvider> = {};
  if (env.GROQ_API_KEY) providers.groq = createGroqProvider({ apiKey: env.GROQ_API_KEY });
  if (env.GOOGLE_API_KEY) {
    providers.gemini = createGeminiProvider({ apiKey: env.GOOGLE_API_KEY });
  }
  return providers;
}

/**
 * Routes whose provider is not configured are dropped, so the gateway never tries a provider it
 * cannot reach; a task left with no routes ends as a policy error ("no eligible route").
 */
export function routingFor(
  providers: Record<string, AiProvider>,
  routing: RoutingConfig = defaultRouting,
): Record<AiTask, RouteEntry[]> {
  const entries = AI_TASKS.map((task) => [
    task,
    (routing[task] ?? []).filter(
      (route) =>
        (providers as Partial<Record<string, AiProvider>>)[route.provider] !== undefined,
    ),
  ]);
  return Object.fromEntries(entries) as Record<AiTask, RouteEntry[]>;
}

/**
 * The budget of the e2e fake AI: no token limits, and a wait for a paced model's output window
 * (the vision model's 1,000 tokens a minute) passes on a clock of its own instead of sleeping, so
 * consecutive scripted OCR calls never wait in real time.
 */
export function createFakeAiBudget(): TokenBudget {
  let skipped = 0;
  return new TokenBudget(
    { perMinute: Number.MAX_SAFE_INTEGER, perDay: Number.MAX_SAFE_INTEGER },
    () => Date.now() + skipped,
    (ms) => {
      skipped += ms;
      return Promise.resolve();
    },
  );
}

/**
 * With the e2e fake AI on, the caller's budget is replaced by an unlimited one: the scripted
 * answers cost nothing, and the per-minute free-tier estimate (prompt plus reserved output, per
 * attempt) would otherwise refuse the repair retry of a 5-question batch and defer it.
 */
export function createRuntimeGateway(
  budget: TokenBudget,
  processEnv: Record<string, string | undefined> = process.env,
) {
  const providers = createRuntimeProviders(getEnv(), processEnv);
  const effectiveBudget = isFakeAiEnabled(processEnv) ? createFakeAiBudget() : budget;
  return createGateway({
    routing: routingFor(providers),
    providers,
    budget: effectiveBudget,
  });
}
