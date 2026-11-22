import type { AiTask, RouteEntry } from "./types";

// generate_questions/solve_independent's Groq models are confirmed by the
// accepted P0-18 benchmark (ADR-0009). The Gemini fallback entries still use
// a placeholder model name -- picking a real one needs a live rate-limit
// check that needs an authenticated Google account session (see ADR-0009's
// "Candidates to evaluate", still open).
// Only zero-retention providers may receive C1 (drafts) and C2 (materials).
const GENERATE_ROUTES: RouteEntry[] = [
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    allowedDataClasses: ["C0", "C1", "C2"],
  },
  { provider: "gemini", model: "gemini-flash", allowedDataClasses: ["C0"] },
];

// Solving a teacher's problem (typed text or a photo's confirmed extraction) is teacher-provided
// content: callers send it as C2, so only Groq routes take it. The strong model, as for generation.
const SOLVE_PROBLEM_ROUTES: RouteEntry[] = [
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    allowedDataClasses: ["C1", "C2"],
    maxOutputTokens: 3000,
  },
];

// Every task has routes here (the type requires it), even though RoutingConfig itself is partial.
export const defaultRouting: Record<AiTask, RouteEntry[]> = {
  generate_questions: GENERATE_ROUTES,
  // One question again, from the teacher's request: the same models (and the same quota) as a batch.
  regenerate_question: GENERATE_ROUTES,
  solve_independent: [
    {
      provider: "groq",
      model: "openai/gpt-oss-20b",
      allowedDataClasses: ["C0", "C1", "C2"],
    },
  ],
  // The vision model: page images and solver photos. Groq's free tier allows it 1,000 output
  // tokens a minute, so one call reserves at most 900 (decision 5) and calls are paced.
  ocr_page: [
    {
      provider: "groq",
      model: "qwen/qwen3.8-27b",
      allowedDataClasses: ["C1", "C2"],
      vision: true,
      otpm: 1000,
      maxOutputTokens: 900,
    },
  ],
  parse_request: [
    { provider: "groq", model: "openai/gpt-oss-20b", allowedDataClasses: ["C0", "C1"] },
    { provider: "gemini", model: "gemini-flash", allowedDataClasses: ["C0"] },
  ],
  // Sections and metadata proposed from a material's extracted text (C2).
  propose_structure: [
    {
      provider: "groq",
      model: "openai/gpt-oss-20b",
      allowedDataClasses: ["C1", "C2"],
      maxOutputTokens: 2000,
    },
  ],
  solve_problem: SOLVE_PROBLEM_ROUTES,
  // "Show another method" uses the same model and quota as the first solve.
  alternative_method: SOLVE_PROBLEM_ROUTES,
};
