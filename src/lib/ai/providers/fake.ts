import type { AiCompleteOptions, AiProvider, AiUsage } from "../types";

export interface FakeCall {
  model: string;
  system: string;
  prompt: string;
  // What the caller passed; the gateway always passes the output cap, plus any images.
  options?: AiCompleteOptions;
}

// A function entry computes its answer from the call, for a test whose answer depends on the
// prompt (for example the solver picking an option by its text).
export type FakeResponse = string | Error | ((system: string, prompt: string) => string);

const DEFAULT_USAGE: AiUsage = { inputTokens: 100, outputTokens: 50 };

// Plays back `responses` in order; an Error entry is thrown instead of returned. Every call reports `usage` (a fixed value, so tests can sum it).
export function createFakeProvider(
  name: string,
  responses: FakeResponse[],
  usage: AiUsage = DEFAULT_USAGE,
): AiProvider & { calls: FakeCall[] } {
  const queue = [...responses];
  const calls: FakeCall[] = [];
  return {
    name,
    calls,
    complete(model, system, prompt, options) {
      calls.push(
        options === undefined
          ? { model, system, prompt }
          : { model, system, prompt, options },
      );
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(`Fake provider "${name}" has no more responses.`),
        );
      }
      if (next instanceof Error) return Promise.reject(next);
      const text = typeof next === "function" ? next(system, prompt) : next;
      return Promise.resolve({ text, usage: { ...usage } });
    },
  };
}
