import type { EvalReport } from "./run-eval";

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function pass(rate: number, threshold: number): string {
  return rate >= threshold ? "LULUS" : "BELUM";
}

// Keeps free text (e.g. a multi-line zod error containing "|") from breaking
// a Markdown table row.
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatMarkdown(report: EvalReport): string {
  const { summary, thresholds } = report;
  const lines: string[] = [];

  lines.push(
    `# Laporan Eval P0-17 (${report.provider})`,
    "",
    `Dibuat: ${report.generatedAt}`,
    "",
  );
  lines.push("## Ringkasan terhadap ambang batas D-019", "");
  lines.push("| Metrik | Nilai | Ambang | Status |", "|---|---|---|---|");
  lines.push(
    `| Kunci jawaban benar | ${pct(summary.keyAccuracyRate)} | ${pct(thresholds.correctKeys)} | ${pass(summary.keyAccuracyRate, thresholds.correctKeys)} |`,
  );
  lines.push(
    `| Kesalahan tertanam tertangkap | ${pct(summary.plantedErrorCatchRate)} | ${pct(thresholds.plantedErrorsCaught)} | ${pass(summary.plantedErrorCatchRate, thresholds.plantedErrorsCaught)} |`,
  );
  lines.push(
    `| Skema valid | ${pct(summary.schemaValidRate)} | ${pct(thresholds.schemaValid)} | ${pass(summary.schemaValidRate, thresholds.schemaValid)} |`,
  );
  lines.push(
    `| Kesepakatan cross-check | ${pct(summary.crossCheckAgreementRate)} | - | - |`,
  );
  lines.push(`| Akurasi solver | ${pct(summary.solverAccuracyRate)} | - | - |`);
  lines.push(`| Total token | ${String(summary.totalTokens)} | - | - |`);
  lines.push(`| Rata-rata latensi | ${summary.avgLatencyMs.toFixed(0)} ms | - | - |`, "");

  lines.push(
    "## Soal hasil generate — lembar penilaian kualitas Bahasa Indonesia",
    "",
    "Beri skor 1-5 untuk setiap soal berikut sesuai rubrik tertulis (lihat ADR-0009), lalu isi kolom di bawah.",
    "",
  );
  for (const item of report.generation) {
    lines.push(`### ${item.specId}`, "");
    if (!item.ok || !item.question) {
      lines.push(`Gagal: ${item.error ?? "tidak diketahui"}`, "");
      continue;
    }
    lines.push(`Soal: ${item.question.stem_md}`, "");
    for (const option of item.question.options) {
      lines.push(`- ${option.label}. ${option.text_md}`);
    }
    // Blank lines between each of these are required, not cosmetic: without
    // one, CommonMark's lazy-continuation rule treats the next line as part
    // of the preceding list item's paragraph, so "Jawaban ditandai" (and
    // "Penjelasan" after it) would render glued onto the last option instead
    // of as their own lines.
    lines.push("", `Jawaban ditandai: ${item.question.correctLabel}`, "");
    lines.push(`Penjelasan: ${item.question.explanation_md}`, "");
    lines.push("Skor (1-5): ____", "", "Catatan: ____", "");
  }

  lines.push("## Hasil solver mandiri", "");
  lines.push("| Soal | Benar | Error |", "|---|---|---|");
  for (const item of report.solver) {
    lines.push(
      `| ${item.problemId} | ${item.correct ? "ya" : "tidak"} | ${escapeTableCell(item.error ?? "-")} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

export function formatJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}
