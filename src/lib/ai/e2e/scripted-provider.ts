import { defaultRouting } from "../routing.config";
import type { AiProvider } from "../types";
import { getE2eAiState, type E2eMaterialTask } from "./control";
import { addendsOf } from "./material-scripts";
import { answerFor, type AnswerContext, type E2eTask } from "./scenarios";

const USAGE = { inputTokens: 100, outputTokens: 50 };
const MAX_LOG_LINES = 200;

const GENERATE_MODELS: string[] = defaultRouting.generate_questions.map(
  (route) => route.model,
);
const SOLVE_MODELS: string[] = defaultRouting.solve_independent.map(
  (route) => route.model,
);

// How a request is told apart (the AiProvider interface only gives model, system and prompt):
//
//  - generate vs solver: by MODEL, taken from defaultRouting (generate_questions routes vs
//    solve_independent routes). Routing picks the model per task, so the model is a reliable
//    task key. The repair retry (gateway.ts callWithRepair) calls the same provider again with
//    the same model and the original prompt plus a "Keluaran sebelumnya tidak valid" suffix, so it
//    is simply the NEXT generate call; scenarios script it by call index (malformed_*).
//  - regeneration (verify-batch.ts, one replacement question): a generate-model call whose prompt
//    carries the correction block "Catatan perbaikan (soal sebelumnya ditolak ...", which
//    buildGenerateMcPrompt adds only when a correctionNote is given. It has its own counter.
//  - the requested question count: "Buat <N> soal pilihan ganda" at the start of the generate
//    prompt.
//  - parse_request shares the solver's model (openai/gpt-oss-20b) in the routing table, so it would
//    be classed as a solver call; the generation pipeline never makes that call, and a prompt
//    that does not name a "Soal: Hitung $n + n$." stem fails loudly rather than being answered.
//  - the question a solver call is about: the fixtures' stem "Hitung $n + n$." appears in the
//    solver prompt ("Soal: ..."), so the agreeing answer (machine 2n, and the letter of the option holding it) is derived from it.
const CORRECTION_MARKER = "Catatan perbaikan (soal sebelumnya ditolak";

// The materials and solver calls share models with generation (gpt-oss-120b solves problems,
// gpt-oss-20b proposes structures and cross-checks solutions), so they are told apart FIRST, by a
// phrase of their system prompt (each prompt builder's own wording; the feature tests build the
// real prompts and check that each lands on its task). Then the model decides, as above.
const SYSTEM_MARKERS: readonly [string, E2eMaterialTask][] = [
  ["Kamu menyalin teks dari gambar satu halaman", "ocr_page"],
  ["Kamu menyalin satu soal matematika SMP", "extract_problem"],
  ["mengenali struktur sebuah materi", "propose_structure"],
  ["memeriksa penyelesaian soal", "solve_problem"],
  ["Kamu memeriksa soal matematika SMP secara mandiri", "solve_cross_check"],
];
// "Show another method": the solve prompt then lists the methods to avoid.
const ALTERNATIVE_MARKER = "Gunakan metode yang BERBEDA";

// The teacher's problem sits between these markers in the solve and cross-check prompts.
function problemOf(prompt: string): string {
  return /<<<SOAL\n([\s\S]*?)\nSOAL>>>/.exec(prompt)?.[1] ?? "";
}

function materialContext(task: E2eMaterialTask, prompt: string): AnswerContext {
  if (task === "propose_structure") {
    const pages = /^Jumlah halaman: (\d+)\./m.exec(prompt)?.[1];
    const topic = /^- (\S+): [^\n]*Persamaan Linear Dua Variabel/im.exec(prompt)?.[1];
    return pages === undefined
      ? {}
      : { pageCount: Number(pages), topicKey: topic?.trim() ?? null };
  }
  if (task === "ocr_page" || task === "extract_problem") return {};
  const addends = addendsOf(problemOf(prompt));
  return addends ? { addends } : {};
}

function classify(
  model: string,
  system: string,
  prompt: string,
): { task: E2eTask | "unknown"; context: AnswerContext } {
  const marked = SYSTEM_MARKERS.find(([phrase]) => system.includes(phrase))?.[1];
  if (marked) {
    const task =
      marked === "solve_problem" && prompt.includes(ALTERNATIVE_MARKER)
        ? "alternative_method"
        : marked;
    return { task, context: materialContext(task, prompt) };
  }
  if (GENERATE_MODELS.includes(model)) {
    const count = /^Buat (\d+) soal pilihan ganda/.exec(prompt)?.[1];
    // Material mode: the passage ids the questions may cite.
    const ids = /Gunakan HANYA id berikut: ([^\n]+?)\.\n/.exec(prompt)?.[1];
    const context: AnswerContext = {
      ...(count === undefined ? {} : { count: Number(count) }),
      ...(ids === undefined ? {} : { passageIds: ids.split(/,\s*/) }),
    };
    return {
      task: prompt.includes(CORRECTION_MARKER) ? "regenerate" : "generate",
      context,
    };
  }
  if (SOLVE_MODELS.includes(model)) {
    const n = /Soal: Hitung \$(\d+) \+ \1\$/.exec(prompt)?.[1];
    if (n === undefined) return { task: "solver", context: {} };
    // The saved options are shuffled: find the one that holds 2n.
    const label = new RegExp(`^([A-D])\\. ${String(2 * Number(n))}$`, "m").exec(
      prompt,
    )?.[1] as "A" | "B" | "C" | "D" | undefined;
    return { task: "solver", context: { n: Number(n), ...(label ? { label } : {}) } };
  }
  return { task: "unknown", context: {} };
}

// Scripted stand-in for a real provider, used by the AI runtime when isFakeAiEnabled(). It reads
// the scenario from globalThis state on every call, so a test can switch it between calls.
// It never returns undefined and never hangs: an unscripted call throws an error naming the
// scenario, task and call index.
export function createScriptedProvider(name: string): AiProvider {
  return {
    name,
    complete(model, system, prompt) {
      const state = getE2eAiState();
      const scenario = state.scenario;
      const { task, context } = classify(model, system, prompt);
      if (task === "unknown") {
        return Promise.reject(
          new Error(
            `e2e scripted AI: scenario=${scenario} task=unknown call=${String(
              state.calls.generate + state.calls.regenerate + state.calls.solver,
            )} has no scripted answer (model=${model})`,
          ),
        );
      }

      const callIndex = state.calls[task] ?? 0;
      state.calls[task] = callIndex + 1;
      const answer = answerFor(scenario, task, callIndex, context);
      if (state.log.length < MAX_LOG_LINES) {
        state.log.push(
          `${name} scenario=${scenario} task=${task} call=${String(callIndex)} ${
            answer instanceof Error ? `error=${answer.message}` : "ok"
          }`,
        );
      }
      if (answer instanceof Error) {
        // One throttle, then the retry sees the happy path (spec: the retry uses `valid`).
        if (scenario === "rate_limited") state.scenario = "valid";
        return Promise.reject(answer);
      }
      return Promise.resolve({ text: answer, usage: { ...USAGE } });
    },
  };
}
