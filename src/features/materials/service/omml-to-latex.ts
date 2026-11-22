// Word equations (OMML) to LaTeX. The converter lives in docx.worker.mjs, because the DOCX
// extraction that uses it runs on a worker thread from a file the bundler copies unbundled
// (Ruling R15); this is its typed entry for the main thread. See the worker for what is supported.
import { ommlToLatex as convert } from "./docx.worker.mjs";

/**
 * One Word equation (`<m:oMath>`, or an `<m:oMathPara>` display block) as LaTeX without `$`
 * delimiters, or null when it holds a construct the converter does not support (the page is then
 * flagged `uncertain_math`) or is not one well-formed equation.
 */
export function ommlToLatex(xml: string): string | null {
  return convert(xml);
}
