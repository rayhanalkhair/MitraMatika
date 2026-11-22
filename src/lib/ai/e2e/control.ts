// Test-only seam: when E2E_FAKE_AI=1 the AI runtime uses a scripted provider (see
// scripted-provider.ts). It is hard-disabled in production (Vercel builds and `next start` run
// with NODE_ENV=production) no matter what the flag says; the control route uses the same gate.
// The literal `process.env.NODE_ENV` check is deliberate: Next inlines it at build time, so a
// production bundle folds this function to false even if the process is started with another
// NODE_ENV. The injectable `env` supplies the flag (and a second NODE_ENV check) for tests.
export function isFakeAiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // An allow-list: an unset or unknown NODE_ENV is off too.
  return (
    env.E2E_FAKE_AI === "1" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test")
  );
}

export const SCENARIOS = [
  "valid",
  "malformed_repairable",
  "malformed_twice",
  "wrong_key_persistent",
  "rate_limited",
  // Material mode: question 1 cites a passage id the prompt never gave (and so does its
  // regeneration), so its citations are rejected (plan decision 8).
  "invented_citation",
] as const;

export type Scenario = (typeof SCENARIOS)[number];

// The calls of the materials and solver features (told apart by system prompt, see
// scripted-provider.ts); counted only once one is made.
export type E2eMaterialTask =
  | "ocr_page"
  | "extract_problem"
  | "propose_structure"
  | "solve_problem"
  | "alternative_method"
  | "solve_cross_check";

export interface E2eAiState {
  scenario: Scenario;
  // Per kind of call since the last reset (a repair retry counts as another generate call).
  calls: { generate: number; regenerate: number; solver: number } & Partial<
    Record<E2eMaterialTask, number>
  >;
  log: string[];
}

type GlobalWithState = typeof globalThis & { __e2eAi?: E2eAiState };

function freshState(scenario: Scenario = "valid"): E2eAiState {
  return { scenario, calls: { generate: 0, regenerate: 0, solver: 0 }, log: [] };
}

// On globalThis: the dev server reloads modules and the runtime builds providers per step, so
// module-level state would be lost between the control route and the pipeline.
export function getE2eAiState(): E2eAiState {
  const holder = globalThis as GlobalWithState;
  holder.__e2eAi ??= freshState();
  return holder.__e2eAi;
}

export function setScenario(scenario: Scenario): void {
  (globalThis as GlobalWithState).__e2eAi = freshState(scenario);
}

export function resetE2eAi(): void {
  (globalThis as GlobalWithState).__e2eAi = freshState();
}
