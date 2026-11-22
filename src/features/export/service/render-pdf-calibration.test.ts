// Measures what the PDF caps allow. Skipped unless PDF_CALIBRATE is set (it takes minutes and
// hundreds of MB); run each case in a fresh process for a true peak:
//   PDF_CALIBRATE="rows,cols,formulas" pnpm exec vitest run src/features/export/service/render-pdf-calibration.test.ts
// Appends one JSON line to .spikes-output/pdf-calibration.jsonl (Vitest hides console output): formulas, chars, formula characters, time, baseline and peak RSS (the peak
// includes the Vitest process baseline of about 230 MB), pages.
import { appendFileSync, mkdirSync } from "node:fs";
import { describe, it } from "vitest";
import { matrixPaper } from "../test-fixtures/pdf-cap-docs";
import { documentSize, renderPdf } from "./render-pdf";

const spec = process.env.PDF_CALIBRATE;

describe.skipIf(!spec)("PDF cap calibration", () => {
  it("renders one matrix paper and reports time and memory", async () => {
    const [rows, cols, formulas] = (spec ?? "4,4,100").split(",").map(Number);
    const doc = matrixPaper(formulas, { rows, cols });
    const size = documentSize(doc, "paper");
    const baseMB = process.resourceUsage().maxRSS / 1024;
    const started = performance.now();
    const result = await renderPdf(doc, "paper", { timeoutMs: 600_000 }).catch(
      (error: unknown) => ({ error: String(error) }),
    );
    const ms = Math.round(performance.now() - started);
    const peakMB = Math.round(process.resourceUsage().maxRSS / 1024);
    mkdirSync(".spikes-output", { recursive: true });
    appendFileSync(
      ".spikes-output/pdf-calibration.jsonl",
      JSON.stringify({
        rows,
        cols,
        ...size,
        ms,
        baseMB: Math.round(baseMB),
        peakMB,
        pages: "pages" in result ? result.pages : result.error,
      }) + "\n",
    );
  }, 600_000);
});
