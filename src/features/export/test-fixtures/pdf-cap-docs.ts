// Documents for the PDF cap calibration and its tests: a paper made only of dense matrix formulas,
// so that the number of formulas and the characters inside formulas can be set exactly.
import { buildDocumentModel, type ExportDocument } from "../service/document-model";
import { snapshot, template, version } from "../test-support";

/**
 * A matrix formula of `rows` x `cols` two-digit entries (about 3 characters each) followed by a
 * column vector; `seed` makes each formula different, so the formula cache cannot hide the cost.
 */
export function matrixFormula(seed: number, rows: number, cols: number): string {
  const body = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) =>
      String(10 + ((seed + 7 * r + 3 * c) % 90)),
    ).join("&"),
  ).join(String.raw`\\`);
  const vector = Array.from({ length: rows }, (_, r) => `x_{${String(r)}}`).join(
    String.raw`\\`,
  );
  return String.raw`$\begin{bmatrix}${body}\end{bmatrix}\cdot\begin{pmatrix}${vector}\end{pmatrix}$`;
}

/**
 * A paper whose stems hold `formulas` matrix formulas in all, `perStem` to a stem, and nothing
 * else (the four options of the fixture version are plain text).
 */
export function matrixPaper(
  formulas: number,
  options: { rows?: number; cols?: number; perStem?: number } = {},
): ExportDocument {
  const { rows = 4, cols = 4, perStem = 10 } = options;
  const base = snapshot();
  const versions = new Map<string, ReturnType<typeof version>>();
  const items = Array.from({ length: Math.ceil(formulas / perStem) }, (_, index) => {
    const count = Math.min(perStem, formulas - index * perStem);
    const stem = Array.from({ length: count }, (_, k) =>
      matrixFormula(index * perStem + k, rows, cols),
    ).join(" ");
    const id = `m${String(index)}`;
    versions.set(`v-${id}`, version(stem, "B"));
    return {
      ...base.sections[0].items[0],
      itemId: id,
      questionId: `q-${id}`,
      versionId: `v-${id}`,
    };
  });
  return buildDocumentModel(
    snapshot({ sections: [{ ...base.sections[0], items }], versions }),
    template,
  );
}
