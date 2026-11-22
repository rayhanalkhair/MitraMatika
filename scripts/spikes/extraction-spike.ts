/**
 * P0-20 extraction spike (ADR-0012, throwaway/time-boxed, PARTIAL).
 *
 * What this actually tests, given no Vercel project and no Groq/Gemini API
 * key exist in this environment yet:
 *   - unpdf's PDF text-layer extraction against a real government PDF (the
 *     official CP Matematika Fase D decree — public, non-copyrighted content,
 *     already fetched during Phase 0D research).
 *   - unpdf's text-layer extraction against our own KaTeX-rendered PDF
 *     (export-spike.ts's output), to see how math renders in the text layer.
 *   - mammoth's DOCX text/structure extraction against our own OMML-bearing
 *     DOCX (export-spike.ts's output), to see whether native Word equations
 *     survive extraction at all.
 *
 * NOT tested here (needs Phase 0C + P0-22 + real API keys):
 *   - page rendering and OCR with a real vision model
 *   - a real scanned textbook page or phone photo
 *   - Vercel Hobby cold start / memory / duration
 *
 * Run: pnpm exec tsx scripts/spikes/extraction-spike.ts
 *
 * This script is typechecked by `pnpm verify` (tsconfig includes all
 * .ts files) but never executed by CI or pnpm verify itself. If this
 * spike is ever removed, remove mammoth/unpdf from package.json's
 * devDependencies in the same commit (docx is a runtime dependency of the
 * export feature and stays).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

// Not committed (see .gitignore's .spikes-output/ entry) — this is the
// official CP Matematika Fase D PDF fetched during Phase 0D research
// (public government regulation content, not a copyrighted textbook).
const CP_PDF_PATH = join(
  process.cwd(),
  ".spikes-output/fixtures/cp-matematika-fase-d.pdf",
);
// Real, official Kemendikdasmen textbooks (copyrighted, not committed — see
// data/golden-set/README.md's "Sourcing and licensing" section for the same
// git-exclusion rationale applied here).
const TEXTBOOK_KELAS_VIII_PATH = join(
  process.cwd(),
  ".spikes-output/fixtures/Matematika-BS-KLS-VIII-Baru.pdf",
);
const TEXTBOOK_KELAS_IX_PATH = join(
  process.cwd(),
  ".spikes-output/fixtures/Matematika-BS-KLS-IX.pdf",
);
const KATEX_PDF_PATH = join(process.cwd(), ".spikes-output/export-sample.pdf");
const DOCX_PATH = join(process.cwd(), ".spikes-output/export-sample.docx");

function garbageRatio(text: string): number {
  if (text.length === 0) return 1;
  const garbage = text.match(/[^\x20-\x7E\nÀ-ɏ]/g)?.length ?? 0;
  return garbage / text.length;
}

async function inspectPdf(label: string, path: string) {
  if (!existsSync(path)) {
    console.log(`\n[${label}] SKIPPED — file not found at ${path}`);
    console.log(
      `  (the CP Matematika PDF fixture is not committed; see docs/research/curriculum-sources.md §1 for its source URL if you need to re-fetch it)`,
    );
    return;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const start = Date.now();
  const doc = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(doc, { mergePages: true });
  const ms = Date.now() - start;
  const ratio = garbageRatio(text);
  console.log(`\n[${label}]`);
  console.log(
    `  pages: ${String(totalPages)}, chars: ${String(text.length)}, extract time: ${String(ms)} ms`,
  );
  console.log(`  garbage-character ratio: ${(ratio * 100).toFixed(2)}%`);
  console.log(`  first 300 chars:\n  ${text.slice(0, 300).replace(/\n/g, "\\n")}`);
}

async function inspectDocx(path: string) {
  if (!existsSync(path)) {
    console.log(`\n[DOCX via mammoth] SKIPPED — file not found at ${path}`);
    return;
  }
  const start = Date.now();
  const result = await mammoth.extractRawText({ path });
  const ms = Date.now() - start;
  console.log(`\n[DOCX via mammoth] extract time: ${String(ms)} ms`);
  console.log(`  warnings: ${String(result.messages.length)}`);
  for (const message of result.messages) {
    console.log(`    - ${message.type}: ${message.message}`);
  }
  console.log(`  extracted text:\n  ${result.value.replace(/\n/g, "\\n")}`);
}

async function main() {
  await inspectPdf("Official CP Matematika PDF (real government content)", CP_PDF_PATH);
  await inspectPdf(
    "Real textbook 1/2: Matematika Kelas VIII (Kemendikdasmen)",
    TEXTBOOK_KELAS_VIII_PATH,
  );
  await inspectPdf(
    "Real textbook 2/2: Matematika Kelas IX (Kemendikdasmen)",
    TEXTBOOK_KELAS_IX_PATH,
  );
  await inspectPdf("Our own KaTeX-rendered PDF (export-sample.pdf)", KATEX_PDF_PATH);
  await inspectDocx(DOCX_PATH);
}

main().catch((error: unknown) => {
  console.error(
    "Extraction spike gagal:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
