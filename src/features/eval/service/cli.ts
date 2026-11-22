import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TokenBudget } from "@/lib/ai/budget";
import { createGateway } from "@/lib/ai/gateway";
import { createFakeProvider } from "@/lib/ai/providers/fake";
import { createGroqProvider } from "@/lib/ai/providers/groq";
import { defaultRouting } from "@/lib/ai/routing.config";
import type { RoutingConfig } from "@/lib/ai/types";
import { requireGroqApiKey } from "@/lib/env";
import { loadGrade8SeedV1 } from "@/features/curriculum";
import {
  validateGoldenGenerationSet,
  validateGoldenSolverSet,
} from "../schema/golden-set-schema";
import { formatJson, formatMarkdown } from "./report";
import { InMemoryAiCallLog, runEval } from "./run-eval";

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8"));
}

// A fixed, deterministic set of valid responses so `npm run eval` (fake mode)
// exercises the full harness and report pipeline for free — the content is a
// placeholder, not real scoring, since correctness against real math isn't
// the point of a fake-provider run.
function fakeBatchJson(): string {
  return JSON.stringify({
    questions: [
      {
        stem_md: "Soal contoh (penyedia palsu).",
        options: [
          { label: "A", text_md: "1" },
          { label: "B", text_md: "2" },
          { label: "C", text_md: "3" },
          { label: "D", text_md: "4" },
        ],
        correctLabel: "B",
        answer: { display_md: "2", machine: "2" },
        explanation_md: "Contoh penjelasan.",
        steps: ["Langkah contoh pertama.", "Langkah contoh kedua."],
        verification_claims: [{ type: "numeric_eval", expression: "1+1", expected: "2" }],
        metadata: { difficulty: "mudah" },
      },
    ],
  });
}

function fakeSolveJson(): string {
  return JSON.stringify({
    correctLabel: "B",
    answer: { display_md: "2", machine: "2" },
    steps: ["Langkah contoh."],
  });
}

function buildFakeResponses(generationCount: number, solverCount: number): string[] {
  const responses: string[] = [];
  for (let i = 0; i < generationCount; i += 1) {
    responses.push(fakeBatchJson(), fakeSolveJson());
  }
  for (let i = 0; i < solverCount; i += 1) {
    responses.push(fakeSolveJson());
  }
  return responses;
}

// Real-mode eval is single-model benchmark evidence for ADR-0009, so it must
// never silently fall back to another provider (and only groq is wired here —
// a gemini route would throw "Unknown provider" once groq's budget is spent).
function groqOnlyRouting(routing: RoutingConfig): RoutingConfig {
  const result = {} as RoutingConfig;
  for (const task of Object.keys(routing) as (keyof RoutingConfig)[]) {
    result[task] = (routing[task] ?? []).filter((route) => route.provider === "groq");
  }
  return result;
}

// Pause between golden-set items in real mode: one generation item costs up to
// 2 real calls (~5400 tokens worst case); 5400 tokens per 45 s averages about
// 7200 tokens/minute, safely under the real budget's perMinute: 8000. (The
// budget is a rolling 60 s window per model, so this is an average, not a
// hard guarantee.) Do not shorten this without redoing that math.
const REAL_MODE_DELAY_MS = 45000;

async function main() {
  const useReal = process.argv.includes("--real");

  const generationRaw = await loadJson(
    join(process.cwd(), "data/golden-set/generation-specs.v1.json"),
  );
  const generationResult = validateGoldenGenerationSet(generationRaw);
  if (!generationResult.ok) {
    console.error(
      "Golden generation specs tidak valid:",
      generationResult.errors.join("; "),
    );
    process.exitCode = 1;
    return;
  }

  const solverRaw = await loadJson(
    join(process.cwd(), "data/golden-set/solver-problems.v1.json"),
  );
  const solverResult = validateGoldenSolverSet(solverRaw);
  if (!solverResult.ok) {
    console.error("Golden solver problems tidak valid:", solverResult.errors.join("; "));
    process.exitCode = 1;
    return;
  }

  const seed = loadGrade8SeedV1();
  const topicScopeNotes = new Map(seed.topics.map((t) => [t.stableKey, t.scopeNotes]));

  const callLog = new InMemoryAiCallLog();
  // In real mode, keep the same rate limit as ai:smoke (src/lib/ai/smoke.ts) to
  // protect real Groq quota. In fake mode, a full eval run makes up to ~50 calls
  // back-to-back near-instantly — well within one rolling minute — so the same
  // per-minute cap would artificially self-throttle with no real network delay
  // between calls; widen it there (matching perDay) since no real quota is at risk.
  const budget = useReal
    ? new TokenBudget({ perMinute: 8000, perDay: 200000 })
    : new TokenBudget({ perMinute: 200000, perDay: 200000 });

  let groq;
  if (useReal) {
    let apiKey: string;
    try {
      apiKey = requireGroqApiKey();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    groq = createGroqProvider({ apiKey, logger: callLog });
  } else {
    groq = createFakeProvider(
      "groq",
      buildFakeResponses(
        generationResult.value.items.length,
        solverResult.value.items.length,
      ),
    );
  }

  const gateway = createGateway({
    routing: useReal ? groqOnlyRouting(defaultRouting) : defaultRouting,
    providers: { groq },
    budget,
  });

  if (useReal) {
    const itemCount =
      generationResult.value.items.length + solverResult.value.items.length;
    const estimatedMinutes = Math.ceil((itemCount * REAL_MODE_DELAY_MS) / 60000);
    console.log(
      "Menjalankan eval dengan Groq asli (dengan jeda antar-soal untuk menghormati " +
        `batas kuota, akan memakan waktu sekitar ${String(estimatedMinutes)} menit)...`,
    );
  } else {
    console.log("Menjalankan eval dengan penyedia palsu...");
  }
  const report = await runEval(
    gateway,
    generationResult.value.items,
    solverResult.value.items,
    topicScopeNotes,
    callLog.entries,
    useReal ? { provider: "real", delayMs: REAL_MODE_DELAY_MS } : { provider: "fake" },
  );

  // Separate files per mode so a fake run never overwrites the hand-filled
  // ratings (Skor 1-5) in the real report.
  const outDir = join(process.cwd(), ".data/eval");
  const reportBaseName = useReal ? "report.real" : "report.fake";
  const mdPath = join(outDir, `${reportBaseName}.md`);
  const jsonPath = join(outDir, `${reportBaseName}.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(mdPath, formatMarkdown(report), "utf-8");
  await writeFile(jsonPath, formatJson(report), "utf-8");

  console.log(
    `Selesai. Skema valid: ${(report.summary.schemaValidRate * 100).toFixed(1)}%, ` +
      `kunci benar: ${(report.summary.keyAccuracyRate * 100).toFixed(1)}%, ` +
      `kesalahan tertangkap: ${(report.summary.plantedErrorCatchRate * 100).toFixed(1)}%.`,
  );
  console.log(`Laporan ditulis ke ${mdPath} dan ${jsonPath}`);
}

main().catch((error: unknown) => {
  console.error("Eval gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
