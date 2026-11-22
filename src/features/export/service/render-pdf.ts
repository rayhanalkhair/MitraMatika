// Prints an exported document to PDF with React-PDF (ADR for plan 2026-11-22-react-pdf): the
// same ExportDocument the HTML preview and the Word file read, laid out by the components in
// pdf/. No browser, no binary: it runs in any Node function.
//
// What keeps it safe (plan decision 9):
// - no network: images are `{ data, format }` objects decoded by us, fonts are registered from
//   bytes, text is only ever a Text child (never markup); nothing here passes a URL to
//   React-PDF, and Font.registerEmojiSource is never called;
// - input caps: a document over MAX_SOURCE_CHARS or MAX_FORMULAS is refused before any layout
//   (`tooLarge`), because layout cost is synchronous and grows with both (see the caps below);
// - time: PDF_TIMEOUT_MS per render. The layout runs on the event loop and cannot be
//   interrupted, so the timeout wins the race when the render returns control; the caps keep
//   the blocked stretch short. No worker thread (worker files are not traced into page
//   functions, which would bring back the deferral this renderer removes);
// - typed errors with fixed messages; the original error is only the `cause`.
import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { cloneElement } from "react";
import type { ExportDocument } from "./document-model";
import { createMathCache, type MathCache } from "./pdf/math-box";
import { ExportPdfDocument } from "./pdf/document";
import { loadPdfFonts } from "./pdf/fonts";
import type { PdfContext } from "./pdf/context";
import { parseRich } from "./rich-blocks";
import type { DocumentKind } from "./render-html";
import type { RenderWarning } from "./rich-text";
import type { LogoOmittedWarning } from "./warnings";

export const PDF_TIMEOUT_MS = 60_000;

/**
 * Input caps per rendered document (`documentSize`), calibrated in Task 6 (ruling P1; numbers in
 * .superpowers/sdd/2026-11-22-react-pdf/task-6-report.md, reproducible with
 * `render-pdf-calibration.test.ts`). Memory follows the glyphs drawn, that is the characters
 * inside formulas, so that has its own cap; the three caps hold together (each is a maximum):
 * - peak RSS is about 315 MB + 11 MB per 1 000 formula characters on the dev laptop (Node 26,
 *   Windows) and includes the Vitest process baseline of about 230 MB, so a function's own
 *   baseline makes these figures conservative, but they are not Vercel measurements;
 * - the worst allowed shapes: 262 formulas of 4 x 4 matrices at the formula-character cap take
 *   3.6 s and 680 MB; 420 formulas of 2 x 2 matrices 2.5 s and 511 MB; 60 000 characters of
 *   prose 0.7 s and 290 MB. Without the formula-character cap, 420 formulas of 4 x 4 matrices
 *   (57 500 characters) reached 965 MB;
 * - a realistic paper (40 items x 3 formulas; solutions with a formula in each of 5 steps:
 *   27 500 characters, 360 formulas, about 6 500 formula characters) passes with wide headroom
 *   and renders in 2.7 s at 480 MB.
 */
export const MAX_SOURCE_CHARS = 60_000;
export const MAX_FORMULAS = 420;
export const MAX_FORMULA_CHARS = 36_000;

export type RenderPdfErrorCode = "render" | "timeout" | "tooLarge";

// Fixed messages: never a stem, a path or the renderer's own text (those stay in `cause`).
const MESSAGES: Record<RenderPdfErrorCode, string> = {
  render: "PDF renderer: the document could not be printed",
  timeout: "PDF renderer: the render did not finish in time",
  tooLarge: "PDF renderer: the document is too large to print",
};

export class RenderPdfError extends Error {
  readonly code: RenderPdfErrorCode;

  constructor(code: RenderPdfErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = "RenderPdfError";
    this.code = code;
  }
}

export interface RenderPdfResult {
  bytes: Uint8Array;
  pages: number;
  warnings: (RenderWarning | LogoOmittedWarning)[];
}

/**
 * Page objects in a PDF (`/Type /Page`, not the `/Pages` tree). React-PDF writes them
 * uncompressed; 0 means the count is unknown.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

export interface DocumentSize {
  /** Characters of everything the document prints (Markdown sources, titles, labels). */
  chars: number;
  /** Formula occurrences. */
  formulas: number;
  /** Characters inside formulas (they are part of `chars`): memory follows these. */
  formulaChars: number;
}

/**
 * What the layout of this kind of document has to process. `chars` is the length of everything
 * the kind prints: the Markdown of the paper (stems, the four options, exam and section
 * instructions), of the solutions (stems, the correct option, steps) or of the key (the
 * answers), plus the plain texts of the letterhead and title block (titles, subject, date,
 * school, header lines, section titles, student-field labels), which every kind prints.
 * `formulas` counts each occurrence; `formulaChars` is the total length of their sources.
 * The sum stops early once `chars` passes MAX_SOURCE_CHARS (the result then only says "over"),
 * so a huge input is not parsed before it is refused.
 */
export function documentSize(doc: ExportDocument, kind: DocumentKind): DocumentSize {
  const size: DocumentSize = { chars: 0, formulas: 0, formulaChars: 0 };
  const over = () => size.chars > MAX_SOURCE_CHARS;
  const plainText = (text: string | null | undefined) => {
    size.chars += text?.length ?? 0;
  };
  const markdown = (md: string | null | undefined) => {
    if (md === null || md === undefined || md === "" || over()) return;
    size.chars += md.length;
    if (over()) return;
    for (const block of parseRich(md)) {
      const sources =
        block.kind === "display"
          ? [block.source]
          : block.runs.flatMap((run) => (run.kind === "math" ? [run.source] : []));
      size.formulas += sources.length;
      for (const source of sources) size.formulaChars += source.length;
    }
  };
  plainText(doc.meta.title);
  plainText(doc.meta.subject);
  plainText(doc.meta.examDate);
  plainText(doc.header.schoolName);
  for (const line of doc.header.lines) plainText(line);
  for (const field of doc.studentFields) plainText(field.label);
  if (kind === "paper") markdown(doc.meta.instructionsMd);
  for (const section of doc.sections) {
    plainText(section.title);
    if (kind === "paper") markdown(section.instructionsMd);
    for (const item of section.items) {
      if (over()) return size;
      if (kind === "key") {
        plainText(item.answerMd);
        continue;
      }
      markdown(item.stemMd);
      if (kind === "paper") {
        for (const option of item.options ?? []) markdown(option.textMd);
      } else {
        markdown(item.options?.find((option) => option.label === item.answerMd)?.textMd);
        for (const step of item.steps) markdown(step);
      }
    }
  }
  return size;
}

/** The page count of the render's own layout (`onRender` data), or null when it is not there. */
export function layoutPageCount(rendered: unknown): number | null {
  const layout = (
    rendered as { _INTERNAL__LAYOUT__DATA_?: { children?: unknown } } | null
  )?._INTERNAL__LAYOUT__DATA_;
  return Array.isArray(layout?.children) ? layout.children.length : null;
}

/**
 * The page count to trust: the pages found in the file, which must be at least one and agree
 * with the render's own layout when that is known (null = React-PDF did not say). Anything else
 * means the count cannot be trusted and the document is not used.
 */
export function confirmedPages(counted: number, laidOut: number | null): number {
  if (counted === 0 || (laidOut !== null && laidOut !== counted)) {
    throw new Error("page count mismatch");
  }
  return counted;
}

// A render that lost the race (timeout) cannot be cancelled and keeps its memory until it ends:
// the next render waits for it, so renders never overlap even after a timeout.
let unfinished: Promise<unknown> = Promise.resolve();

/**
 * Renders one document. Refuses an over-cap document before any layout (`tooLarge`), gives up
 * after `timeoutMs` (`timeout`), and turns any other failure into `render`. Callers run one
 * render at a time per instance (`oneAtATime`).
 */
export async function renderPdf(
  doc: ExportDocument,
  kind: DocumentKind,
  options: { timeoutMs?: number; math?: MathCache } = {},
): Promise<RenderPdfResult> {
  const timeoutMs = options.timeoutMs ?? PDF_TIMEOUT_MS;
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = (async (): Promise<RenderPdfResult> => {
    const size = documentSize(doc, kind);
    if (
      size.chars > MAX_SOURCE_CHARS ||
      size.formulas > MAX_FORMULAS ||
      size.formulaChars > MAX_FORMULA_CHARS
    ) {
      throw new RenderPdfError("tooLarge");
    }
    // Wait for a render that timed out and is still running (bounded by the timeout).
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        unfinished,
        new Promise<never>((_, reject) => {
          waitTimer = setTimeout(() => {
            reject(new RenderPdfError("timeout"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(waitTimer);
    }
    // The Liberation fonts are a 4 MB module loaded on first use (dynamic import).
    await loadPdfFonts();
    const ctx: PdfContext = {
      warnings: [],
      where: { part: "instructions" },
      math: options.math ?? createMathCache(),
    };
    let laidOutPages = null as number | null;
    const element = cloneElement(ExportPdfDocument({ doc, kind, ctx }), {
      onRender: (rendered) => {
        laidOutPages = layoutPageCount(rendered);
      },
    });
    const rendering = renderToBuffer(element);
    unfinished = rendering.catch(() => undefined);
    const bytes = new Uint8Array(await rendering);
    const pages = confirmedPages(countPdfPages(bytes), laidOutPages);
    // The layout runs on the event loop without yielding to timers for long stretches, so the
    // race below may never see the timer fire: a render that overran is a timeout all the same.
    if (performance.now() - started > timeoutMs) throw new RenderPdfError("timeout");
    return { bytes, pages, warnings: ctx.warnings };
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RenderPdfError("timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error instanceof RenderPdfError) throw error;
    throw new RenderPdfError("render", { cause: error });
  } finally {
    clearTimeout(timer);
    // After a timeout the render may still fail later: nobody listens any more.
    work.catch(() => undefined);
  }
}
