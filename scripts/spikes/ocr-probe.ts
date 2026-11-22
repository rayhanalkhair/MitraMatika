/**
 * P0-20 OCR spike (ADR-0012, throwaway/time-boxed).
 *
 * Calls the real Groq vision model (qwen/qwen3.8-27b) directly against the
 * 6 real textbook scan images already in the P0-16 golden set, and compares
 * its transcription to the known-correct expectedText_md for each page.
 *
 * This bypasses src/lib/ai's gateway entirely and talks to Groq's
 * chat/completions endpoint directly, because AiProvider.complete() only
 * accepts a plain string prompt -- there is no way to attach an image
 * through the current gateway abstraction. That's a real finding, not a
 * spike shortcut: the ocr_page task cannot be built against today's gateway
 * without first extending AiProvider to accept image content, since this is
 * exactly the multimodal request shape Phase 5's real OCR feature will need.
 *
 * Run: pnpm exec tsx --env-file-if-exists=.env.local scripts/spikes/ocr-probe.ts
 *
 * This script is typechecked by `pnpm verify` (tsconfig includes all
 * .ts files) but never executed by CI or pnpm verify itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireGroqApiKey } from "../../src/lib/env";

const MANIFEST_PATH = join(
  process.cwd(),
  ".spikes-output/fixtures/ocr-pages/ocr-pages.v1.json",
);
const MODEL = "qwen/qwen3.8-27b";

interface OcrFixture {
  id: string;
  kind: string;
  path: string;
  pageNumber: number;
  expectedText_md: string;
  sourceRef: string;
}

const SYSTEM_PROMPT =
  "Kamu adalah asisten OCR yang membaca gambar halaman buku matematika SMP " +
  "dan mengubahnya menjadi teks Markdown. Notasi matematika HARUS ditulis " +
  "sebagai LaTeX diapit $...$ atau $$...$$. Jika ada bagian yang tidak bisa " +
  "kamu baca dengan yakin, tandai dengan [tidak jelas] alih-alih menebak. " +
  "Kembalikan HANYA teks Markdown hasil transkripsi, tanpa penjelasan " +
  "tambahan dan tanpa blok kode.";

// Crude normalized Levenshtein similarity (0-1), same spirit as
// extraction-spike.ts's garbageRatio() probe: good enough to rank fixtures
// by how close the transcription got, not a calibrated accuracy metric.
function similarity(a: string, b: string): number {
  const dp: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) dp[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  const distance = dp[b.length];
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

async function ocrPage(
  apiKey: string,
  imagePath: string,
): Promise<{
  text: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  ms: number;
}> {
  const bytes = readFileSync(join(process.cwd(), imagePath));
  const base64 = bytes.toString("base64");
  const ext = imagePath.endsWith(".jpg") || imagePath.endsWith(".jpeg") ? "jpeg" : "png";

  const start = Date.now();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Transkripsikan halaman ini." },
            {
              type: "image_url",
              image_url: { url: `data:image/${ext};base64,${base64}` },
            },
          ],
        },
      ],
      temperature: 0.2,
      // qwen/qwen3.8-27b's free-tier OTPM (output tokens per minute) limit
      // is 1000 -- a single dense page's uncapped transcription can exceed
      // that in ONE request, which Groq rejects outright rather than
      // truncating. Capping here trades completeness for actually getting a
      // response; production OCR needs a real strategy for this (smaller
      // page crops, a summarizing pass, or accepting truncation + manual
      // review, per ADR-0012 point 6).
      max_tokens: 900,
    }),
  });

  const ms = Date.now() - start;
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Groq API status ${String(response.status)}: ${bodyText.slice(0, 500)}`,
    );
  }
  const data = JSON.parse(bodyText) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return {
    text,
    tokensPrompt: data.usage?.prompt_tokens,
    tokensCompletion: data.usage?.completion_tokens,
    ms,
  };
}

async function main() {
  const apiKey = requireGroqApiKey();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
    items: OcrFixture[];
  };
  const scans = manifest.items.filter((item) => item.kind === "scan");

  console.log(
    `Menguji OCR (${MODEL}) terhadap ${String(scans.length)} halaman scan real...\n`,
  );

  const results: { id: string; similarity: number; ms: number; tokens: number }[] = [];

  let first = true;
  for (const fixture of scans) {
    if (!first) {
      // Stay under the 1000 OTPM (output tokens per minute) free-tier
      // ceiling found during this probe's first run.
      await new Promise((resolve) => setTimeout(resolve, 65000));
    }
    first = false;
    console.log(`=== ${fixture.id} (halaman ${String(fixture.pageNumber)}) ===`);
    try {
      const result = await ocrPage(apiKey, fixture.path);
      const sim = similarity(fixture.expectedText_md, result.text);
      const tokens = (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0);
      results.push({ id: fixture.id, similarity: sim, ms: result.ms, tokens });

      console.log(
        `waktu: ${String(result.ms)}ms, token: ${String(tokens)}, similarity: ${(sim * 100).toFixed(1)}%`,
      );
      console.log(`--- EXPECTED ---\n${fixture.expectedText_md}`);
      console.log(`--- ACTUAL ---\n${result.text}\n`);
    } catch (error) {
      console.log(`GAGAL: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  console.log("\n=== RINGKASAN ===");
  for (const r of results) {
    console.log(
      `${r.id}: similarity ${(r.similarity * 100).toFixed(1)}%, ${String(r.ms)}ms, ${String(r.tokens)} token`,
    );
  }
  if (results.length > 0) {
    const avgSim = results.reduce((sum, r) => sum + r.similarity, 0) / results.length;
    const avgMs = results.reduce((sum, r) => sum + r.ms, 0) / results.length;
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    console.log(
      `\nRata-rata similarity: ${(avgSim * 100).toFixed(1)}%, rata-rata waktu: ${avgMs.toFixed(0)}ms, total token: ${String(totalTokens)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("OCR probe gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
