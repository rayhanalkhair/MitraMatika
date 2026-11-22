/**
 * React-PDF spike (plan 2026-11-22-react-pdf, Task 1, throwaway/time-boxed).
 *
 * Collects the evidence for the go/no-go on replacing the headless-Chromium PDF renderer with
 * React-PDF plus MathJax SVG formulas. Checks (see docs/research/react-pdf-spike-findings.md):
 *   s2   the 76 SMP corpus formulas through MathJax route A (TeX input) and B (KaTeX MathML in)
 *   s3   inline baseline offset, measured on a 4x raster (pdfjs-dist + @napi-rs/canvas)
 *   s4   pagination: 30 long items, one oversized item, footer render prop
 *   s5   worst case time, longest event-loop block and peak RSS (200 items, three documents)
 *   s6   a hostile document with fetch, http(s).request and net.connect stubbed to throw
 *   s8   font fallback for symbols outside WinAnsi, and how Font.register takes bytes
 *   fs   every fs read during one render (S7, plain Node half)
 *
 * Run: pnpm exec tsx scripts/spikes/react-pdf-spike.tsx [--only=s2,s3,...]
 * Output: .spikes-output/react-pdf/ (git-ignored): PDFs, PNGs and results.<step>.json.
 *
 * Not run with --conditions=react-server: under that condition `react` has no client internals
 * and @react-pdf/reconciler throws at load (finding F1 of the findings file). React-PDF is also
 * ESM-only and its CJS-compiled import fails inside tsx, so it is loaded with a dynamic import().
 *
 * This script is typechecked and linted with the project but never run by CI or `pnpm verify`.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- the project tsconfig has no
   noUncheckedIndexedAccess, so the many `array[i] ?? default` guards of this throwaway script look
   unnecessary to the linter although the index can be out of range. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createCanvas } from "@napi-rs/canvas";
import katex from "katex";
import { type ComponentProps, type ReactElement } from "react";
import { extractText, getDocumentProxy } from "unpdf";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { MathML } from "mathjax-full/js/input/mathml.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import type * as ReactPdf from "@react-pdf/renderer";
import { withDecimalComma } from "../../src/components/math/decimal-comma";

type Rp = typeof ReactPdf;
let rp!: Rp;

const OUT = join(process.cwd(), ".spikes-output", "react-pdf");
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg === undefined ? null : onlyArg.slice("--only=".length).split(",");
const wants = (step: string) => ONLY === null || ONLY.includes(step);

const save = (name: string, data: unknown) => {
  fs.writeFileSync(join(OUT, name), JSON.stringify(data, null, 2));
};
const log = (...parts: unknown[]) => {
  console.log(...parts);
};
const ms = (t0: number) => Math.round(performance.now() - t0);
const fixed = (n: number, digits = 2) => Number(n.toFixed(digits));

// ---------------------------------------------------------------------------------------------
// Formulas: KaTeX validates, MathJax typesets to SVG paths (fontCache none: no font for maths).
// ---------------------------------------------------------------------------------------------

interface SvgNode {
  tag: "svg" | "g" | "path" | "rect" | "line" | "text";
  attrs: Record<string, string>;
  children: SvgNode[];
  text?: string;
}
interface MathBox {
  viewBox: [number, number, number, number];
  widthEm: number;
  heightEm: number;
  depthEm: number;
  nodes: SvgNode[];
}
type MathErrorCode = "parse" | "unsupported" | "limit";
class MathError extends Error {
  constructor(
    readonly code: MathErrorCode,
    readonly detail = "",
  ) {
    super(`math: ${code}`);
  }
}

interface LiteAdaptorLike {
  kind(node: unknown): string;
  allAttributes(node: unknown): { name: string; value: string }[];
  childNodes(node: unknown): unknown[];
  textContent(node: unknown): string;
}

const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "line", "text"]);
const ALLOWED_ATTRS = new Set([
  "d",
  "transform",
  "x",
  "y",
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "x1",
  "y1",
  "x2",
  "y2",
]);

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const lite = adaptor as unknown as LiteAdaptorLike;
const output = new SVG({ fontCache: "none" });
const throwing = (_jax: unknown, error: Error): never => {
  throw error;
};
const texDocument = mathjax.document("", {
  InputJax: new TeX({ packages: ["base", "ams"], formatError: throwing }),
  OutputJax: output,
});
const mathmlDocument = mathjax.document("", {
  InputJax: new MathML(),
  OutputJax: new SVG({ fontCache: "none" }),
});

const KATEX_BASE = {
  throwOnError: true,
  strict: "ignore",
  maxSize: 10,
  maxExpand: 100,
} as const;

/** KaTeX validation (the same set of failures as the preview); returns MathML for route B. */
function katexMathMl(source: string, display: boolean): string {
  const refused: string[] = [];
  let rendered: string;
  try {
    rendered = katex.renderToString(withDecimalComma(source), {
      ...KATEX_BASE,
      output: "mathml",
      displayMode: display,
      trust: (context) => {
        refused.push(context.command);
        return false;
      },
    });
  } catch (cause) {
    throw new MathError("parse", cause instanceof Error ? cause.name : "?");
  }
  if (refused.length > 0) throw new MathError("unsupported", "trust");
  const math = /<math[\s\S]*<\/math>/.exec(rendered)?.[0];
  if (math === undefined) throw new MathError("parse", "no math element");
  return math.replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, "");
}

function walk(node: unknown, stats: SpikeStats): SvgNode | null {
  const tag = lite.kind(node);
  if (tag === "#text" || tag === "#comment") return null;
  if (!ALLOWED_TAGS.has(tag)) {
    stats.unknownTags[tag] = (stats.unknownTags[tag] ?? 0) + 1;
    throw new MathError("unsupported", tag);
  }
  const attrs: Record<string, string> = {};
  for (const { name, value } of lite.allAttributes(node)) {
    if (name === "data-mml-node" && value === "merror")
      throw new MathError("parse", "merror");
    if (!ALLOWED_ATTRS.has(name)) {
      stats.droppedAttrs[name] = (stats.droppedAttrs[name] ?? 0) + 1;
      continue;
    }
    attrs[name] = value === "currentColor" ? "#000000" : value;
    if (/https?:/i.test(value)) throw new MathError("unsupported", "url");
  }
  // `stroke-width="0"` means "no stroke" in SVG; React-PDF would draw a hairline (looks bold).
  if (attrs["stroke-width"] === "0") {
    delete attrs.stroke;
    delete attrs["stroke-width"];
  } else if (attrs["stroke-width"] !== undefined && attrs.stroke === undefined) {
    // An enclosure (box, strike) strokes with the colour the root group set (currentColor).
    attrs.stroke = "#000000";
  }
  if (tag === "svg") stats.nestedSvg++;
  const children: SvgNode[] = [];
  for (const child of lite.childNodes(node)) {
    const converted = walk(child, stats);
    if (converted) children.push(converted);
  }
  const out: SvgNode = { tag: tag as SvgNode["tag"], attrs, children };
  if (tag === "text") out.text = lite.textContent(node);
  return out;
}

interface SpikeStats {
  unknownTags: Record<string, number>;
  droppedAttrs: Record<string, number>;
  nestedSvg: number;
}
const newStats = (): SpikeStats => ({ unknownTags: {}, droppedAttrs: {}, nestedSvg: 0 });

function boxFromContainer(container: unknown, stats: SpikeStats): MathBox {
  const svg = lite.childNodes(container).find((n) => lite.kind(n) === "svg");
  if (svg === undefined) throw new MathError("parse", "no svg");
  const root = walk(svg, stats);
  stats.nestedSvg--; // the root svg itself
  const viewBox = root?.attrs.viewBox?.split(/\s+/).map(Number);
  if (
    root === null ||
    viewBox?.length !== 4 ||
    viewBox.some((n) => !Number.isFinite(n))
  ) {
    throw new MathError("parse", "viewBox");
  }
  const [x, y, w, h] = viewBox as [number, number, number, number];
  return {
    viewBox: [x, y, w, h],
    widthEm: w / 1000,
    heightEm: -y / 1000,
    depthEm: (y + h) / 1000,
    nodes: root.children,
  };
}

type Route = "A" | "B";
function latexToMathBox(
  source: string,
  display: boolean,
  route: Route,
  stats: SpikeStats,
): MathBox {
  // Both routes validate with KaTeX first, so the failing set matches the preview and Word.
  const mathMl = katexMathMl(source, display);
  let container: unknown;
  try {
    container =
      route === "B"
        ? mathmlDocument.convert(mathMl, { display })
        : texDocument.convert(withDecimalComma(source), { display });
  } catch (cause) {
    throw new MathError(
      "parse",
      cause instanceof Error ? cause.message.slice(0, 60) : "?",
    );
  }
  return boxFromContainer(container, stats);
}

function loadCorpus(): string[] {
  const text = fs.readFileSync(
    join(process.cwd(), "src/features/export/service/omml-schema.test.ts"),
    "utf8",
  );
  const body = /const SMP_CORPUS = String\.raw`([\s\S]*?)`\.split/.exec(text)?.[1];
  if (body === undefined) throw new Error("SMP_CORPUS not found");
  return body.split("\n");
}

// ---------------------------------------------------------------------------------------------
// React-PDF building blocks.
// ---------------------------------------------------------------------------------------------

const camel = (name: string) =>
  name.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

function SvgTree({ node }: { node: SvgNode }): ReactElement {
  const props: Record<string, string> = {};
  for (const [name, value] of Object.entries(node.attrs)) props[camel(name)] = value;
  const kids = node.children.map((child, index) => <SvgTree key={index} node={child} />);
  switch (node.tag) {
    case "g":
      return <rp.G {...props}>{kids}</rp.G>;
    case "path":
      return <rp.Path {...(props as { d: string })} />;
    case "rect":
      return <rp.Rect {...(props as { width: string; height: string })} />;
    case "line":
      return <rp.Line {...(props as unknown as ComponentProps<Rp["Line"]>)} />;
    case "text":
      return <Txt {...props}>{node.text}</Txt>;
    case "svg": {
      // A nested <svg> (stretchy accents, braces): React-PDF has no nested Svg, so it becomes a
      // group that maps the nested viewBox onto its x, y, width, height (meet, centred).
      const vb = (node.attrs.viewBox ?? "").split(/\s+/).map(Number);
      const [vx = 0, vy = 0, vw = 1, vh = 1] = vb;
      const x = Number(node.attrs.x ?? 0);
      const y = Number(node.attrs.y ?? 0);
      const w = Number(node.attrs.width ?? vw);
      const h = Number(node.attrs.height ?? vh);
      const scale = Math.min(w / vw, h / vh);
      const tx = x + (w - vw * scale) / 2 - vx * scale;
      const ty = y + (h - vh * scale) / 2 - vy * scale;
      return (
        <rp.G
          transform={`translate(${tx.toFixed(3)},${ty.toFixed(3)}) scale(${scale.toFixed(5)})`}
        >
          {kids}
        </rp.G>
      );
    }
  }
}

interface FormulaProps {
  box: MathBox;
  fs: number;
  scale?: number;
  marginBottom?: number;
}
function Formula({ box, fs, scale = 1, marginBottom = 0 }: FormulaProps): ReactElement {
  const [x, y, w, h] = box.viewBox;
  return (
    <rp.Svg
      viewBox={`${String(x)} ${String(y)} ${String(w)} ${String(h)}`}
      width={(w / 1000) * fs * scale}
      height={(h / 1000) * fs * scale}
      style={{ marginBottom }}
    >
      {box.nodes.map((node, index) => (
        <SvgTree key={index} node={node} />
      ))}
    </rp.Svg>
  );
}

type FontKind = "times" | "arial";
const FAMILY: Record<FontKind, string> = { times: "Times-Roman", arial: "Helvetica" };
// Average advance of a space, in em (Times 250, Helvetica 278 units).
const SPACE_EM: Record<FontKind, number> = { times: 0.25, arial: 0.278 };

/** Distance from the bottom of a 1.4 line-height Text box up to its baseline, in em (S3). */
let BASELINE_K: Record<FontKind, number> = { times: 0, arial: 0 };

type Part =
  { kind: "text"; text: string } | { kind: "math"; box: MathBox | null; source: string };

function InlineParagraph({
  parts,
  fs,
  font,
}: {
  parts: Part[];
  fs: number;
  font: FontKind;
}): ReactElement {
  const items: ReactElement[] = [];
  const space = SPACE_EM[font] * fs;
  let key = 0;
  parts.forEach((part, partIndex) => {
    if (part.kind === "text") {
      const next = parts[partIndex + 1];
      const words = part.text.split(/(\s+)/);
      // Words with the gap that follows them as a right margin (a trailing space in a Text
      // may be trimmed at a line end, a margin is exact).
      const tokens: { word: string; gap: boolean }[] = [];
      for (let i = 0; i < words.length; i += 2) {
        const word = words[i] ?? "";
        const gap = (words[i + 1] ?? "") !== "";
        if (word !== "" || gap) tokens.push({ word, gap });
      }
      const startsWithGap = /^\s/.test(part.text) && partIndex > 0;
      tokens.forEach((token, tokenIndex) => {
        if (token.word === "") return;
        const last = tokenIndex === tokens.length - 1;
        items.push(
          <Txt
            key={key++}
            style={{
              fontFamily: FAMILY[font],
              fontSize: fs,
              lineHeight: 1.4,
              marginRight:
                token.gap || (last && next?.kind === "math" && false) ? space : 0,
              marginLeft:
                tokens.findIndex((t) => t.word !== "") === tokenIndex && startsWithGap
                  ? space
                  : 0,
            }}
          >
            {token.word}
          </Txt>,
        );
      });
    } else if (part.box === null) {
      items.push(
        <Txt
          key={key++}
          style={{ fontFamily: "Courier", fontSize: fs, lineHeight: 1.4 }}
        >{`$${part.source}$`}</Txt>,
      );
    } else {
      const depthPt = part.box.depthEm * fs;
      items.push(
        <Formula
          key={key++}
          box={part.box}
          fs={fs}
          marginBottom={BASELINE_K[font] * fs - depthPt}
        />,
      );
    }
  });
  return (
    <rp.View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end" }}>
      {items}
    </rp.View>
  );
}

const A4: [number, number] = [595.28, 841.89];

/**
 * Every Text sets its own line height: a `lineHeight` on Page (or View) style breaks pagination
 * and makes `fixed` footers disappear in @react-pdf 4.9.0 (finding F5). fontSize is set here too:
 * a unitless lineHeight is multiplied by the default 18 pt when fontSize is only inherited.
 */
function Txt(props: ComponentProps<Rp["Text"]>): ReactElement {
  return (
    <rp.Text
      {...props}
      style={{ fontSize: 12, lineHeight: 1.4, ...(props.style as object | undefined) }}
    />
  );
}

// No lineHeight here: a `fixed` Text with a `render` prop and a lineHeight makes layout produce an
// undefined (1e22) height and the render throws "unsupported number" (finding F5).
function Footer(): ReactElement {
  return (
    <rp.Text
      fixed
      style={{
        position: "absolute",
        bottom: 30,
        left: 0,
        right: 0,
        textAlign: "center",
        fontSize: 10,
        fontFamily: "Times-Roman",
      }}
      render={({ pageNumber, totalPages }) =>
        `Halaman ${String(pageNumber)} dari ${String(totalPages)}`
      }
    />
  );
}

const pageStyle = {
  paddingTop: 51,
  paddingBottom: 62,
  paddingHorizontal: 51,
  fontFamily: "Times-Roman",
  fontSize: 12,
} as const;

async function toBuffer(element: ReactElement): Promise<Uint8Array> {
  const buffer = await rp.renderToBuffer(element as Parameters<Rp["renderToBuffer"]>[0]);
  return new Uint8Array(buffer);
}

async function pageTexts(pdf: Uint8Array): Promise<string[]> {
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: false });
  return text;
}

// ---------------------------------------------------------------------------------------------
// Rasterising (pdfjs-dist + @napi-rs/canvas) and ink measurement.
// ---------------------------------------------------------------------------------------------

interface Raster {
  width: number;
  height: number;
  scale: number;
  data: Uint8ClampedArray;
  png: Buffer;
}
async function rasterize(
  pdf: Uint8Array,
  pageNumber: number,
  scale: number,
): Promise<Raster> {
  // unpdf registers its own (differently versioned) pdf.js worker on globalThis; pdfjs-dist would
  // pick it up and refuse with an API/Worker version mismatch.
  delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: pdf.slice(),
    standardFontDataUrl: `${process.cwd().replaceAll("\\", "/")}/node_modules/pdfjs-dist/standard_fonts/`,
    useSystemFonts: false,
  }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    scale,
    data: image.data,
    png: canvas.toBuffer("image/png"),
  };
}

const isInk = (r: Raster, x: number, y: number) => {
  const i = (y * r.width + x) * 4;
  return (
    (r.data[i] ?? 255) < 140 ||
    (r.data[i + 1] ?? 255) < 140 ||
    (r.data[i + 2] ?? 255) < 140
  );
};

interface InkBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
/** The glyph clusters (in pt, from the page top-left) of the first text band of the page. */
function firstBandClusters(r: Raster): InkBox[] {
  let top = -1;
  let bottom = -1;
  let blank = 0;
  for (let y = 0; y < r.height; y++) {
    let any = false;
    for (let x = 0; x < r.width && !any; x++) any = isInk(r, x, y);
    if (any) {
      if (top < 0) top = y;
      bottom = y;
      blank = 0;
    } else if (top >= 0 && ++blank > r.scale * 6) break;
  }
  const columns: boolean[] = [];
  for (let x = 0; x < r.width; x++) {
    let any = false;
    for (let y = top; y <= bottom && !any; y++) any = isInk(r, x, y);
    columns.push(any);
  }
  const clusters: InkBox[] = [];
  let start = -1;
  let gap = 0;
  const flush = (end: number) => {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let y = top; y <= bottom; y++) {
      for (let x = start; x <= end; x++) {
        if (isInk(r, x, y)) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          break;
        }
      }
    }
    clusters.push({
      x0: start / r.scale,
      x1: (end + 1) / r.scale,
      y0: y0 / r.scale,
      y1: (y1 + 1) / r.scale,
    });
  };
  for (let x = 0; x < columns.length; x++) {
    if (columns[x]) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0 && ++gap > r.scale * 1.5) {
      flush(x - gap);
      start = -1;
    }
  }
  return clusters;
}

// ---------------------------------------------------------------------------------------------
// S2: the corpus.
// ---------------------------------------------------------------------------------------------

interface CorpusResult {
  route: Route;
  mode: "inline" | "display";
  ok: number;
  failed: { source: string; code: string; detail: string }[];
  stats: SpikeStats;
  msTotal: number;
  msPerFormula: number;
  maxWidthEm: number;
}

function runCorpus(route: Route, mode: "inline" | "display", corpus: string[]) {
  const stats = newStats();
  const boxes: (MathBox | null)[] = [];
  const failed: CorpusResult["failed"] = [];
  const t0 = performance.now();
  for (const source of corpus) {
    try {
      boxes.push(latexToMathBox(source, mode === "display", route, stats));
    } catch (error) {
      boxes.push(null);
      failed.push({
        source,
        code: error instanceof MathError ? error.code : "throw",
        detail: error instanceof MathError ? error.detail : String(error),
      });
    }
  }
  const msTotal = performance.now() - t0;
  const result: CorpusResult = {
    route,
    mode,
    ok: boxes.filter((b) => b !== null).length,
    failed,
    stats,
    msTotal: fixed(msTotal, 1),
    msPerFormula: fixed(msTotal / corpus.length, 2),
    maxWidthEm: fixed(Math.max(...boxes.map((b) => b?.widthEm ?? 0))),
  };
  return { result, boxes };
}

async function corpusPdf(
  corpus: string[],
  boxes: (MathBox | null)[],
  mode: "inline" | "display",
  fileName: string,
): Promise<Uint8Array> {
  const rows = corpus.map((source, index) => {
    const box = boxes[index] ?? null;
    return (
      <rp.View key={index} wrap={false} style={{ flexDirection: "row", marginBottom: 5 }}>
        <Txt style={{ width: 150, fontSize: 7, fontFamily: "Courier" }}>
          {`${String(index + 1)} ${source}`.slice(0, 44)}
        </Txt>
        <rp.View
          style={{
            flexGrow: 1,
            alignItems: mode === "display" ? "center" : "flex-start",
          }}
        >
          {box === null ? (
            <Txt style={{ fontSize: 9, color: "#b00" }}>FAILED</Txt>
          ) : (
            <Formula box={box} fs={mode === "display" ? 14 : 12} />
          )}
        </rp.View>
      </rp.View>
    );
  });
  const pdf = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={{ ...pageStyle, fontSize: 9 }}>
        {rows}
        <Footer />
      </rp.Page>
    </rp.Document>,
  );
  fs.writeFileSync(join(OUT, fileName), pdf);
  return pdf;
}

async function stepS2() {
  const corpus = loadCorpus();
  log("S2 corpus size", corpus.length);
  const results: CorpusResult[] = [];
  for (const route of ["A", "B"] as const) {
    for (const mode of ["inline", "display"] as const) {
      const { result, boxes } = runCorpus(route, mode, corpus);
      results.push(result);
      const pdf = await corpusPdf(corpus, boxes, mode, `s2-route-${route}-${mode}.pdf`);
      const pages = (await pageTexts(pdf)).length;
      for (let page = 1; page <= pages; page++) {
        const raster = await rasterize(pdf, page, 2);
        fs.writeFileSync(
          join(OUT, `s2-route-${route}-${mode}-p${String(page)}.png`),
          raster.png,
        );
      }
      log(
        `  route ${route} ${mode}: ok ${String(result.ok)}/${String(corpus.length)} pages ${String(pages)} ${String(result.msPerFormula)} ms/formula`,
      );
      for (const f of result.failed) log(`    miss: ${f.source} [${f.code} ${f.detail}]`);
      log(
        "    unknown tags",
        JSON.stringify(result.stats.unknownTags),
        "nested svg",
        result.stats.nestedSvg,
        "dropped attrs",
        JSON.stringify(result.stats.droppedAttrs),
      );
    }
  }
  save("results.s2.json", results);
}

// ---------------------------------------------------------------------------------------------
// S3: inline baseline.
// ---------------------------------------------------------------------------------------------

function boxOf(source: string, route: Route = "B"): MathBox {
  return latexToMathBox(source, false, route, newStats());
}

async function inlinePdf(font: FontKind, fs: number, route: Route): Promise<Uint8Array> {
  const parts: Part[] = [
    { kind: "text", text: "a " },
    { kind: "math", box: boxOf("x", route), source: "x" },
    { kind: "text", text: " b " },
    { kind: "math", box: boxOf(String.raw`\frac{1}{2}`, route), source: "frac" },
    { kind: "text", text: " c" },
  ];
  return toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={{ ...pageStyle, fontFamily: FAMILY[font], fontSize: fs }}>
        <InlineParagraph parts={parts} fs={fs} font={font} />
      </rp.Page>
    </rp.Document>,
  );
}

interface BaselineMeasure {
  font: FontKind;
  fs: number;
  route: Route;
  k: number;
  clusters: number;
  bottomsPt: { a: number; x: number; b: number; c: number };
  xMinusA: number;
  bMinusA: number;
  cMinusA: number;
  fracBarCenterAboveBaseline: number | null;
  worstDeviation: number;
}

async function measureBaseline(
  font: FontKind,
  fs: number,
  route: Route,
): Promise<BaselineMeasure> {
  const pdf = await inlinePdf(font, fs, route);
  const raster = await rasterize(pdf, 1, 8);
  fs_png(`s3-${font}-${String(fs)}-${route}.png`, raster.png);
  fs_pdf(`s3-${font}-${String(fs)}-${route}.pdf`, pdf);
  const clusters = firstBandClusters(raster);
  const [a, x, b, frac, c] = clusters;
  if (clusters.length !== 5 || !a || !x || !b || !frac || !c) {
    throw new Error(`expected 5 ink clusters, got ${String(clusters.length)}`);
  }
  // The fraction bar is the widest ink row of the fraction cluster.
  let barY: number | null = null;
  let barWidth = 0;
  for (let y = Math.floor(frac.y0 * raster.scale); y < frac.y1 * raster.scale; y++) {
    let width = 0;
    for (let px = Math.floor(frac.x0 * raster.scale); px < frac.x1 * raster.scale; px++) {
      if (isInk(raster, px, y)) width++;
    }
    if (width > barWidth) {
      barWidth = width;
      barY = y;
    }
  }
  const bottoms = { a: a.y1, x: x.y1, b: b.y1, c: c.y1 };
  const baseline = (a.y1 + b.y1 + c.y1) / 3;
  return {
    font,
    fs,
    route,
    k: BASELINE_K[font],
    clusters: clusters.length,
    bottomsPt: Object.fromEntries(
      Object.entries(bottoms).map(([k, v]) => [k, fixed(v, 3)]),
    ) as BaselineMeasure["bottomsPt"],
    xMinusA: fixed(x.y1 - a.y1, 3),
    bMinusA: fixed(b.y1 - a.y1, 3),
    cMinusA: fixed(c.y1 - a.y1, 3),
    fracBarCenterAboveBaseline:
      barY === null ? null : fixed(baseline - (barY + 0.5) / raster.scale, 3),
    worstDeviation: fixed(
      Math.max(Math.abs(x.y1 - a.y1), Math.abs(b.y1 - a.y1), Math.abs(c.y1 - a.y1)),
      3,
    ),
  };
}
const fs_png = (name: string, data: Buffer) => {
  fs.writeFileSync(join(OUT, name), data);
};
const fs_pdf = (name: string, data: Uint8Array) => {
  fs.writeFileSync(join(OUT, name), data);
};

async function stepS3() {
  const out: Record<string, unknown> = {};
  // Calibration: with k = 0 the offset of the formula against the text is the missing k * fs.
  for (const font of ["times", "arial"] as const) {
    BASELINE_K = { times: 0, arial: 0 };
    const uncalibrated = await measureBaseline(font, 12, "B");
    log("S3 uncalibrated", JSON.stringify(uncalibrated));
    // x is drawn lower than a by `xMinusA` when its margin is too small: the margin must grow.
    const k = fixed(uncalibrated.xMinusA / 12, 4);
    BASELINE_K = { ...BASELINE_K, [font]: k };
    const results: BaselineMeasure[] = [];
    for (const fs of [10, 12, 14, 18]) {
      for (const route of ["A", "B"] as const)
        results.push(await measureBaseline(font, fs, route));
    }
    out[font] = { uncalibrated, k, results };
    log(`S3 ${font}: k = ${String(k)} em`);
    for (const r of results) {
      log(
        `  ${font} ${String(r.fs)}pt route ${r.route}: x-a ${String(r.xMinusA)} b-a ${String(r.bMinusA)} c-a ${String(r.cMinusA)} bar ${String(r.fracBarCenterAboveBaseline)} (expect ${String(fixed(0.25 * r.fs, 2))}) worst ${String(r.worstDeviation)}`,
      );
    }
  }
  save("results.s3.json", out);
}

// ---------------------------------------------------------------------------------------------
// S4: pagination.
// ---------------------------------------------------------------------------------------------

const WORDS =
  "persegi panjang keliling luas sisi segitiga sudut lingkaran jari-jari diameter pecahan desimal bilangan bulat rasio perbandingan kecepatan waktu jarak data rata-rata median modus peluang".split(
    " ",
  );
const sentence = (seed: number, words: number) =>
  Array.from({ length: words }, (_v, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(
    " ",
  );

function LongItem({
  n,
  lines,
  wrap,
}: {
  n: number;
  lines: number;
  wrap: boolean;
}): ReactElement {
  const label = String(n).padStart(2, "0");
  return (
    <rp.View wrap={wrap} style={{ marginBottom: 12 }}>
      <Txt>{`AWAL-${label} ${String(n)}. ${sentence(n, lines * 11)}`}</Txt>
      {["A", "B", "C", "D"].map((o) => (
        <Txt
          key={o}
          style={{ marginLeft: 18 }}
        >{`${o}. ${sentence(n + o.charCodeAt(0), 5)}`}</Txt>
      ))}
      <Txt>{`AKHIR-${label}`}</Txt>
    </rp.View>
  );
}

async function stepS4() {
  rp.Font.registerHyphenationCallback((word) => [word]);
  const out: Record<string, unknown> = {};
  // (a) 30 items of varying length, wrap=false everywhere.
  const items = Array.from({ length: Number(process.env.S4_COUNT ?? 30) }, (_v, i) => (
    <LongItem key={i} n={i + 1} lines={3 + ((i * 5) % 14)} wrap={false} />
  ));
  const t0 = performance.now();
  const pdf = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        {items}
        <Footer />
      </rp.Page>
    </rp.Document>,
  );
  fs.writeFileSync(join(OUT, "s4-30-items.pdf"), pdf);
  const texts = await pageTexts(pdf);
  const total = texts.length;
  const splitItems: number[] = [];
  const footerProblems: string[] = [];
  texts.forEach((text, index) => {
    const footers = [...text.matchAll(/Halaman (\d+) dari (\d+)/g)];
    const first = footers[0];
    if (
      footers.length !== 1 ||
      first?.[1] !== String(index + 1) ||
      first[2] !== String(total)
    ) {
      footerProblems.push(
        `page ${String(index + 1)}: ${JSON.stringify(footers.map((f) => f[0]))}`,
      );
    }
  });
  for (let n = 1; n <= 30; n++) {
    const label = String(n).padStart(2, "0");
    const start = texts.findIndex((t) => t.includes(`AWAL-${label} `));
    const end = texts.findIndex((t) => t.includes(`AKHIR-${label}`));
    if (start < 0 || end < 0 || start !== end) splitItems.push(n);
  }
  out.thirtyItems = { pages: total, ms: ms(t0), splitItems, footerProblems };
  log("S4a", JSON.stringify(out.thirtyItems));

  // (b) one item taller than a page, wrap=false (what does React-PDF do?).
  // Run separately in a child process when invoked as a step (see runIsolated).
  save("results.s4.json", out);
}

function bigMatrix(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_v, i) => `${String(i + 1)} & ${String(i + 2)} & x_{${String(i + 1)}}`,
  ).join(String.raw`\\`);
  return String.raw`\begin{bmatrix}${body}\end{bmatrix}`;
}

async function oversizedPdf(
  mode: "wrapFalse" | "wrapTrue" | "wrapFalseMinPresence",
  stemChars: number,
) {
  const matrix = latexToMathBox(bigMatrix(12), true, "B", newStats());
  const stem = (sentence(3, 2000) + " ").slice(0, stemChars);
  const item = (
    <rp.View
      wrap={mode === "wrapTrue" ? true : false}
      minPresenceAhead={mode === "wrapFalseMinPresence" ? 40 : undefined}
    >
      <Txt>{`AWAL-BIG ${stem} AKHIR-STEM`}</Txt>
      <rp.View style={{ alignItems: "center", marginVertical: 6 }}>
        <Formula box={matrix} fs={12} />
      </rp.View>
      <Txt>AKHIR-BIG</Txt>
    </rp.View>
  );
  const pdf = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        <Txt>BEFORE-ITEM intro line</Txt>
        {item}
        <Txt>AFTER-ITEM closing line</Txt>
        <Footer />
      </rp.Page>
    </rp.Document>,
  );
  const matrixPt = (matrix.heightEm + matrix.depthEm) * 12;
  return { pdf, stemLen: stem.length, matrixPt: fixed(matrixPt, 1) };
}

async function stepS4Oversized(
  mode: "wrapFalse" | "wrapTrue" | "wrapFalseMinPresence",
  stemChars: number,
) {
  const t0 = performance.now();
  const { pdf, stemLen, matrixPt } = await oversizedPdf(mode, stemChars);
  const texts = await pageTexts(pdf);
  fs.writeFileSync(join(OUT, `s4-oversized-${mode}-${String(stemChars)}.pdf`), pdf);
  const all = texts.join("\n");
  const raster = await rasterize(pdf, 1, 1);
  fs_png(`s4-oversized-${mode}-${String(stemChars)}-p1.png`, raster.png);
  const result = {
    mode,
    stemChars,
    stemLen,
    matrixPt,
    estimatedPt: fixed(
      Math.ceil((stemLen * 0.5 * 12) / 493.28) * 16.8 + matrixPt + 12 + 16.8 * 2,
      0,
    ),
    pages: texts.length,
    ms: ms(t0),
    markers: {
      before: all.includes("BEFORE-ITEM"),
      awal: all.includes("AWAL-BIG"),
      akhirStem: all.includes("AKHIR-STEM"),
      akhirBig: all.includes("AKHIR-BIG"),
      after: all.includes("AFTER-ITEM"),
    },
    footers: texts.map((t) => /Halaman \d+ dari \d+/.exec(t)?.[0] ?? null),
  };
  log("S4 oversized", JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------------------------
// S5: performance.
// ---------------------------------------------------------------------------------------------

function mathCache(route: Route) {
  const cache = new Map<string, MathBox | null>();
  const stats = newStats();
  let calls = 0;
  return {
    get(source: string, display = false): MathBox | null {
      const key = `${display ? "d" : "i"}:${source}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      calls++;
      let box: MathBox | null;
      try {
        box = latexToMathBox(source, display, route, stats);
      } catch {
        box = null;
      }
      cache.set(key, box);
      return box;
    },
    get typesetCalls() {
      return calls;
    },
  };
}
type Cache = ReturnType<typeof mathCache>;

const STEMS: ((n: number) => Part[])[] = [
  (n) => [
    {
      kind: "text",
      text: `Sebuah persegi panjang memiliki panjang ${String(n + 5)} cm dan lebar `,
    },
    { kind: "math", box: null, source: `\\frac{${String(n + 1)}}{${String(n + 2)}}` },
    {
      kind: "text",
      text: " dari panjangnya. Jika keliling persegi panjang itu sama dengan ",
    },
    { kind: "math", box: null, source: `${String(2 * n + 3)}x + ${String(n)}` },
    {
      kind: "text",
      text: " dan luasnya dinyatakan dalam cm persegi, hitunglah nilai luas yang dimaksud pada soal tersebut.",
    },
  ],
];

const DOC_SIZE = { chars: 0, formulas: 0 };
function resolveParts(parts: Part[], cache: Cache): Part[] {
  for (const p of parts) {
    DOC_SIZE.chars += p.kind === "text" ? p.text.length : p.source.length;
    if (p.kind === "math") DOC_SIZE.formulas++;
  }
  return parts.map((p) => (p.kind === "math" ? { ...p, box: cache.get(p.source) } : p));
}

function perfItem(n: number, cache: Cache, kind: "paper" | "solutions"): ReactElement {
  const stem = resolveParts(STEMS[0]?.(n) ?? [], cache);
  return (
    <rp.View key={n} wrap={false} style={{ marginBottom: 8 }}>
      <rp.View style={{ flexDirection: "row" }}>
        <Txt style={{ width: 22 }}>{`${String(n)}.`}</Txt>
        <rp.View style={{ flexGrow: 1, flexShrink: 1 }}>
          <InlineParagraph parts={stem} fs={12} font="times" />
          {kind === "paper" ? (
            <rp.View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 4 }}>
              {["A", "B", "C", "D"].map((o, i) => (
                <rp.View key={o} style={{ width: "50%", flexDirection: "row" }}>
                  <Txt style={{ width: 16 }}>{`${o}.`}</Txt>
                  <rp.View style={{ flexShrink: 1 }}>
                    <InlineParagraph
                      parts={resolveParts(
                        [
                          { kind: "text", text: `${String(n + i)} cm dan ` },
                          { kind: "math", box: null, source: `${String(n + i)}\\pi` },
                        ],
                        cache,
                      )}
                      fs={12}
                      font="times"
                    />
                  </rp.View>
                </rp.View>
              ))}
            </rp.View>
          ) : (
            [1, 2, 3, 4, 5].map((step) => (
              <rp.View key={step} style={{ flexDirection: "row", marginTop: 3 }}>
                <Txt style={{ width: 18 }}>{`${String(step)}.`}</Txt>
                <rp.View style={{ flexShrink: 1, flexGrow: 1 }}>
                  <InlineParagraph
                    parts={resolveParts(
                      [
                        {
                          kind: "text",
                          text: "Substitusikan nilai yang diketahui ke dalam rumus ",
                        },
                        {
                          kind: "math",
                          box: null,
                          source: `L = ${String(n)} \\times ${String(step)} + \\sqrt{${String(n + step)}}`,
                        },
                        { kind: "text", text: " lalu sederhanakan hasilnya." },
                      ],
                      cache,
                    )}
                    fs={12}
                    font="times"
                  />
                </rp.View>
              </rp.View>
            ))
          )}
        </rp.View>
      </rp.View>
    </rp.View>
  );
}

function perfDocument(
  kind: "paper" | "key" | "solutions",
  cache: Cache,
  count: number,
): ReactElement {
  const chunk = Number(process.env.S5_CHUNK ?? 0);
  if (chunk > 0 && kind !== "key") {
    const pages: ReactElement[] = [];
    for (let from = 0; from < count; from += chunk) {
      pages.push(
        <rp.Page key={from} size={A4} style={pageStyle}>
          {Array.from({ length: Math.min(chunk, count - from) }, (_v, i) =>
            perfItem(from + i + 1, cache, kind),
          )}
          <Footer />
        </rp.Page>,
      );
    }
    return <rp.Document>{pages}</rp.Document>;
  }
  return (
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        {kind === "key"
          ? Array.from({ length: count }, (_v, i) => (
              <rp.View
                key={i}
                wrap={false}
                style={{ flexDirection: "row", borderBottomWidth: 0.5 }}
              >
                <Txt style={{ width: 40 }}>{String(i + 1)}</Txt>
                <Txt style={{ width: 80 }}>{["A", "B", "C", "D"][i % 4]}</Txt>
                <Txt>{"1"}</Txt>
              </rp.View>
            ))
          : Array.from({ length: count }, (_v, i) => perfItem(i + 1, cache, kind))}
        <Footer />
      </rp.Page>
    </rp.Document>
  );
}

async function stepS5(count = 200, only?: ("paper" | "key" | "solutions")[]) {
  rp.Font.registerHyphenationCallback((word) => [word]);
  const baselineRssMb = fixed(process.memoryUsage().rss / 1048576, 0);
  const cache = mathCache("B");
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  const docs: Record<string, unknown> = {};
  const wall0 = performance.now();
  for (const kind of only ?? (["paper", "key", "solutions"] as const)) {
    const t0 = performance.now();
    const typeset0 = cache.typesetCalls;
    DOC_SIZE.chars = 0;
    DOC_SIZE.formulas = 0;
    // Typeset first so its cost is separate from layout.
    const el = perfDocument(kind, cache, count);
    const tTypeset = ms(t0);
    histogram.reset();
    const t1 = performance.now();
    const pdf = await toBuffer(el);
    const tLayout = ms(t1);
    const pages = (await pageTexts(pdf)).length;
    fs.writeFileSync(join(OUT, `s5-${kind}.pdf`), pdf);
    docs[kind] = {
      elementAndTypesetMs: tTypeset,
      renderToBufferMs: tLayout,
      totalMs: ms(t0),
      pages,
      bytes: pdf.length,
      formulasTypeset: cache.typesetCalls - typeset0,
      sourceChars: DOC_SIZE.chars,
      formulas: DOC_SIZE.formulas,
      longestEventLoopBlockMs: fixed(histogram.max / 1e6, 0),
    };
    log("S5", kind, JSON.stringify(docs[kind]));
  }
  clearInterval(sampler);
  histogram.disable();
  const result = {
    items: count,
    baselineRssMb,
    docs,
    totalWallMs: ms(wall0),
    peakRssSampledMb: fixed(peakRss / 1048576, 0),
    maxRssMb: fixed(process.resourceUsage().maxRSS / 1024, 0),
  };
  log("S5 total", JSON.stringify(result));
  if (only === undefined) save(`results.s5-${String(count)}.json`, result);
}

// ---------------------------------------------------------------------------------------------
// S6: hostile document, network stubbed.
// ---------------------------------------------------------------------------------------------

async function stepS6() {
  const calls: string[] = [];
  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
  };
  const trap = (name: string) => () => {
    calls.push(name);
    if (process.env.DEBUG_NET) log(new Error(name).stack);
    throw new Error(`network call blocked: ${name}`);
  };
  // yoga-layout loads its WebAssembly through fetch(<data: URI>) on first use (no network). A
  // data: fetch is allowed and counted apart; any other fetch is a network call and throws.
  const dataFetches: number[] = [];
  const blockFetch = trap("fetch");
  globalThis.fetch = (input: unknown, init?: unknown) => {
    if (typeof input === "string" && input.startsWith("data:")) {
      dataFetches.push(input.length);
      return originals.fetch(input, init as RequestInit | undefined);
    }
    return blockFetch();
  };
  http.request = trap("http.request");
  http.get = trap("http.get");
  https.request = trap("https.request");
  https.get = trap("https.get");
  net.connect = trap("net.connect");
  net.createConnection = trap("net.createConnection");

  const hostileText = [
    "<script>alert(1)</script>",
    "<img src=http://127.0.0.1:9/x>",
    "![x](http://example.com/a.png)",
    String.raw`\href{http://x}{y}`,
    "@import url(http://x)",
    "emoji \u{1F600}\u{1F468}‍\u{1F469}‍\u{1F467}",
    "arab العربية",
    "zwj a‍b",
    Array.from({ length: 32 }, (_v, i) => `c${String(i)}${String.fromCharCode(i)}`).join(
      "",
    ),
    "lone high \uD800 lone low \uDC00 end",
    "x".repeat(300),
  ];
  const outcome: Record<string, unknown> = {};
  try {
    const cache = mathCache("B");
    const hostileMath = cache.get(String.raw`\href{http://x}{y}`);
    const pdf = await toBuffer(
      <rp.Document>
        <rp.Page size={A4} style={pageStyle}>
          {hostileText.map((t, i) => (
            <Txt key={i}>{t}</Txt>
          ))}
          <Txt>{`hostile math cached as ${hostileMath === null ? "null (fallback text)" : "BOX"}`}</Txt>
          <Footer />
        </rp.Page>
      </rp.Document>,
    );
    fs.writeFileSync(join(OUT, "s6-hostile.pdf"), pdf);
    const text = (await pageTexts(pdf)).join("\n");
    outcome.rendered = true;
    outcome.bytes = pdf.length;
    outcome.scriptLiteralInText = text.includes("<script>alert(1)</script>");
    outcome.imgLiteralInText = text.includes("<img src=http://127.0.0.1:9/x>");
    outcome.importLiteralInText = text.includes("@import url(http://x)");
    outcome.hrefMathBecameFallback = hostileMath === null;
  } catch (error) {
    outcome.rendered = false;
    outcome.error = String(error);
  } finally {
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    net.connect = originals.netConnect;
    net.createConnection = originals.netCreateConnection;
  }
  outcome.networkCalls = calls;
  outcome.dataUriFetchesAllowed = dataFetches.length;
  log("S6", JSON.stringify(outcome));
  save("results.s6.json", outcome);
}

// ---------------------------------------------------------------------------------------------
// S8: fonts.
// ---------------------------------------------------------------------------------------------

const SYMBOLS = [
  "∠",
  "⊥",
  "∥",
  "△",
  "∈",
  "∉",
  "⊂",
  "∪",
  "∩",
  "→",
  "⇒",
  "≤",
  "≥",
  "≠",
  "π",
];

async function stepS8() {
  const katexDir = join(process.cwd(), "node_modules/katex/dist/fonts");
  const mainBytes = fs.readFileSync(join(katexDir, "KaTeX_Main-Regular.ttf"));
  const amsBytes = fs.readFileSync(join(katexDir, "KaTeX_AMS-Regular.ttf"));
  const out: Record<string, unknown> = {};
  const dataUri = (b: Buffer) => `data:font/ttf;base64,${b.toString("base64")}`;

  // How Font.register takes bytes: data URI (no fetch, no fs), then a temp path.
  const fetchCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: unknown, init?: unknown) => {
    // yoga-layout fetches its own wasm as a data: URI on first use; that is not the network.
    if (typeof input === "string" && input.startsWith("data:application/octet-stream")) {
      return realFetch(input, init as RequestInit | undefined);
    }
    fetchCalls.push(String(input).slice(0, 40));
    throw new Error("fetch blocked");
  };
  try {
    rp.Font.register({ family: "KaTeXMain", src: dataUri(mainBytes) });
    rp.Font.register({ family: "KaTeXAMS", src: dataUri(amsBytes) });
    rp.Font.registerHyphenationCallback((word) => [word]);

    const sampleRows = (family: string | string[]) =>
      SYMBOLS.map((s, i) => (
        <Txt
          key={i}
          style={{ fontFamily: family, fontSize: 28, lineHeight: 1.6 }}
        >{`${s} x`}</Txt>
      ));
    const render = async (name: string, family: string | string[]) => {
      const pdf = await toBuffer(
        <rp.Document>
          <rp.Page size={A4} style={pageStyle}>
            {sampleRows(family)}
          </rp.Page>
        </rp.Document>,
      );
      fs.writeFileSync(join(OUT, `s8-${name}.pdf`), pdf);
      return pdf;
    };

    for (const [name, family] of [
      ["times-only", "Times-Roman"],
      ["fallback-array", ["Times-Roman", "KaTeXMain", "KaTeXAMS"]],
      ["main-ams-only", ["KaTeXMain", "KaTeXAMS"]],
    ] as const) {
      try {
        const pdf = await render(name, family as string | string[]);
        const raster = await rasterize(pdf, 1, 2);
        fs_png(`s8-${name}.png`, raster.png);
        // Ink per symbol row: rows are 28 * 1.6 = 44.8 pt apart starting at the top margin.
        const rows = SYMBOLS.map((_s, i) => {
          const y0 = Math.floor((51 + i * 44.8) * 2);
          const y1 = Math.floor((51 + (i + 1) * 44.8) * 2);
          // Only the glyph itself: the first 30 pt of the row (the symbol, before " x").
          let ink = 0;
          for (let y = y0; y < y1; y++)
            for (let x = Math.floor(51 * 2); x < Math.floor((51 + 24) * 2); x++)
              if (isInk(raster, x, y)) ink++;
          return ink;
        });
        const latin = pdf.toString().includes("/BaseFont");
        const fonts = [
          ...new Set(
            [
              ...Buffer.from(pdf)
                .toString("latin1")
                .matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g),
            ].map((m) => m[1]),
          ),
        ];
        out[name] = {
          inkBySymbol: Object.fromEntries(SYMBOLS.map((s, i) => [s, rows[i]])),
          missing: SYMBOLS.filter((_s, i) => (rows[i] ?? 0) === 0),
          baseFonts: fonts,
          hasBaseFont: latin,
        };
        log("S8", name, JSON.stringify(out[name]));
      } catch (error) {
        out[name] = { error: String(error) };
        log("S8", name, "ERROR", String(error));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  out.fetchCallsDuringRegisterAndRender = fetchCalls;

  // Bold / italic Times and Helvetica come from the base-14 families.
  const styled = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        <Txt style={{ fontFamily: "Times-Roman", fontWeight: "bold" }}>bold</Txt>
        <Txt style={{ fontFamily: "Times-Roman", fontStyle: "italic" }}>italic</Txt>
        <Txt
          style={{ fontFamily: "Times-Roman", fontWeight: "bold", fontStyle: "italic" }}
        >
          bolditalic
        </Txt>
        <Txt style={{ fontFamily: "Helvetica", fontWeight: "bold" }}>bold</Txt>
        <Txt style={{ fontFamily: "Courier" }}>courier</Txt>
        <Txt style={{ fontFamily: "Times-Roman" }}>
          Indonesia: déjà “dua” – • ° ± × ÷ − ≤
        </Txt>
      </rp.Page>
    </rp.Document>,
  );
  fs.writeFileSync(join(OUT, "s8-styles.pdf"), styled);
  out.baseFontsInStylesPdf = [
    ...new Set(
      [
        ...Buffer.from(styled)
          .toString("latin1")
          .matchAll(/\/BaseFont\s*\/([A-Za-z0-9+_-]+)/g),
      ].map((m) => m[1]),
    ),
  ];

  // Temp-path registration.
  const tmp = fs.mkdtempSync(join(OUT, "font-"));
  const tmpFile = join(tmp, "main.ttf");
  fs.writeFileSync(tmpFile, mainBytes);
  rp.Font.register({ family: "KaTeXMainPath", src: tmpFile });
  const viaPath = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        <Txt style={{ fontFamily: "KaTeXMainPath" }}>{"≤ ≥"}</Txt>
      </rp.Page>
    </rp.Document>,
  );
  out.tempPathRegistrationBytes = viaPath.length;
  fs.rmSync(tmp, { recursive: true, force: true });

  log("S8 done");
  save("results.s8.json", out);
}

// ---------------------------------------------------------------------------------------------
// S7 (plain Node half): every fs read during one full render.
// ---------------------------------------------------------------------------------------------

async function stepFsLog() {
  const reads = new Set<string>();
  const wrap =
    (name: string, original: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string") reads.add(`${name} ${first}`);
      else if (first instanceof URL) reads.add(`${name} ${first.pathname}`);
      return original(...args);
    };
  const targets = [
    "readFile",
    "readFileSync",
    "openSync",
    "open",
    "createReadStream",
    "readdirSync",
    "statSync",
    "existsSync",
  ] as const;
  const originals = new Map<string, unknown>();
  const patched = fs as unknown as Record<string, unknown>;
  for (const name of targets) {
    originals.set(name, patched[name]);
    patched[name] = wrap(name, patched[name] as (...args: unknown[]) => unknown);
  }
  try {
    rp.Font.register({
      family: "KaTeXMainFs",
      src: `data:font/ttf;base64,${fs.readFileSync(join(process.cwd(), "node_modules/katex/dist/fonts/KaTeX_Main-Regular.ttf")).toString("base64")}`,
    });
    reads.clear();
    const cache = mathCache("B");
    await toBuffer(perfDocument("solutions", cache, 5));
    await toBuffer(perfDocument("paper", cache, 5));
    const faces = (["Times-Roman", "Helvetica", "Courier"] as const).flatMap((family) =>
      (["normal", "bold"] as const).flatMap((weight) =>
        (["normal", "italic"] as const).map((style) => ({ family, weight, style })),
      ),
    );
    await toBuffer(
      <rp.Document>
        <rp.Page size={A4} style={pageStyle}>
          {faces.map((face, i) => (
            <Txt
              key={i}
              style={{
                fontFamily: face.family,
                fontWeight: face.weight,
                fontStyle: face.style,
              }}
            >
              face
            </Txt>
          ))}
        </rp.Page>
      </rp.Document>,
    );
  } finally {
    for (const name of targets) patched[name] = originals.get(name);
  }
  const list = [...reads].sort();
  const result = {
    total: list.length,
    reads: list.map((r) =>
      r.replaceAll("\\", "/").replace(process.cwd().replaceAll("\\", "/"), "<repo>"),
    ),
  };
  log("FS reads during render:", result.total);
  for (const r of result.reads) log("  ", r);
  save("results.fs.json", result);
}

// ---------------------------------------------------------------------------------------------
// S4c: a heading keeps with the first item through minPresenceAhead (swept over page positions).
// ---------------------------------------------------------------------------------------------

async function stepS4Heading() {
  rp.Font.registerHyphenationCallback((word) => [word]);
  const out: Record<string, { orphaned: number[]; sweeps: number }> = {};
  for (const keep of [false, true]) {
    const orphaned: number[] = [];
    for (let filler = 20; filler <= 46; filler++) {
      const pdf = await toBuffer(
        <rp.Document>
          <rp.Page size={A4} style={pageStyle}>
            {Array.from({ length: filler }, (_v, i) => (
              <Txt key={i}>{`filler ${String(i)}`}</Txt>
            ))}
            <Txt
              minPresenceAhead={keep ? 90 : undefined}
              style={{ fontWeight: "bold", marginTop: 6 }}
            >
              HEADING-X
            </Txt>
            <rp.View wrap={false}>
              <Txt>{`ITEM-X ${sentence(1, 40)}`}</Txt>
              <Txt>ITEM-X-END</Txt>
            </rp.View>
            <Footer />
          </rp.Page>
        </rp.Document>,
      );
      const texts = await pageTexts(pdf);
      const heading = texts.findIndex((t) => t.includes("HEADING-X"));
      const item = texts.findIndex((t) => t.includes("ITEM-X "));
      if (heading !== item) orphaned.push(filler);
    }
    out[keep ? "withMinPresenceAhead" : "without"] = { orphaned, sweeps: 27 };
  }
  log("S4c", JSON.stringify(out));
  save("results.s4c.json", out);
}

// ---------------------------------------------------------------------------------------------
// S8b: splitByCoverage (the fontFamily fallback array draws wrong glyphs for some symbols).
// ---------------------------------------------------------------------------------------------

/** The code points a TrueType font maps (cmap formats 4 and 12). */
function ttfCoverage(buf: Uint8Array): Set<number> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = dv.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const tag = String.fromCharCode(...buf.subarray(12 + i * 16, 16 + i * 16));
    if (tag === "cmap") cmap = dv.getUint32(12 + i * 16 + 8);
  }
  const set = new Set<number>();
  const subtables = dv.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const at = cmap + dv.getUint32(cmap + 4 + i * 8 + 4);
    const format = dv.getUint16(at);
    if (format === 4) {
      const segments = dv.getUint16(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segments * 2 + 2;
      for (let s = 0; s < segments; s++) {
        const end = dv.getUint16(ends + s * 2);
        for (let c = dv.getUint16(starts + s * 2); c <= end && c < 0xffff; c++)
          set.add(c);
      }
    } else if (format === 12) {
      const groups = dv.getUint32(at + 12);
      for (let g = 0; g < groups; g++) {
        const end = dv.getUint32(at + 20 + g * 12);
        for (let c = dv.getUint32(at + 16 + g * 12); c <= end; c++) set.add(c);
      }
    }
  }
  return set;
}

// What the base-14 fonts draw correctly: WinAnsi (Windows-1252).
const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014,
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030,
  0x2039, 0x203a, 0x20ac, 0x2122,
]);
const inWinAnsi = (cp: number) =>
  cp === 0x0a ||
  (cp >= 0x20 && cp <= 0x7e) ||
  (cp >= 0xa0 && cp <= 0xff) ||
  WIN_ANSI_EXTRA.has(cp);

type RunFamily = "base" | "KaTeXMain" | "KaTeXAMS" | "KaTeXMathItalic" | "box" | "drop";
interface Run {
  family: RunFamily;
  text: string;
}
function splitByCoverage(
  text: string,
  coverage: Record<"main" | "ams" | "mathItalic", Set<number>>,
): Run[] {
  const runs: Run[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    let family: RunFamily;
    if (inWinAnsi(cp)) family = "base";
    else if (
      cp < 0x20 ||
      (cp >= 0x7f && cp < 0xa0) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      cp === 0x200d ||
      cp > 0xffff
    )
      family = "drop";
    else if (coverage.main.has(cp)) family = "KaTeXMain";
    else if (coverage.ams.has(cp)) family = "KaTeXAMS";
    else if (coverage.mathItalic.has(cp)) family = "KaTeXMathItalic";
    else if (cp >= 0x2190 && cp <= 0x22ff)
      family = "box"; // arrows and math operators: a MathJax glyph box
    else family = "drop";
    const last = runs[runs.length - 1];
    if (last?.family === family && family !== "box") last.text += char;
    else runs.push({ family, text: char });
  }
  return runs;
}

async function stepS8b() {
  const dir = join(process.cwd(), "node_modules/katex/dist/fonts");
  const bytes = (name: string) => fs.readFileSync(join(dir, name));
  const uri = (b: Buffer) => `data:font/ttf;base64,${b.toString("base64")}`;
  rp.Font.register({ family: "KaTeXMain", src: uri(bytes("KaTeX_Main-Regular.ttf")) });
  rp.Font.register({ family: "KaTeXAMS", src: uri(bytes("KaTeX_AMS-Regular.ttf")) });
  rp.Font.register({
    family: "KaTeXMathItalic",
    src: uri(bytes("KaTeX_Math-Italic.ttf")),
  });
  rp.Font.registerHyphenationCallback((word) => [word]);
  const coverage = {
    main: ttfCoverage(new Uint8Array(bytes("KaTeX_Main-Regular.ttf"))),
    ams: ttfCoverage(new Uint8Array(bytes("KaTeX_AMS-Regular.ttf"))),
    mathItalic: ttfCoverage(new Uint8Array(bytes("KaTeX_Math-Italic.ttf"))),
  };
  const glyphBox = (char: string): MathBox | null => {
    try {
      const mml = `<math><mo lspace="0" rspace="0">${char}</mo></math>`;
      return boxFromContainer(
        mathmlDocument.convert(mml, { display: false }),
        newStats(),
      );
    } catch {
      return null;
    }
  };
  const rows = SYMBOLS.map((symbol, i) => {
    const runs = splitByCoverage(`${symbol} x`, coverage);
    return {
      symbol,
      families: runs.filter((r) => r.text.trim() !== "").map((r) => r.family),
      node: (
        <rp.View
          key={i}
          style={{ flexDirection: "row", alignItems: "flex-end", height: 40 }}
        >
          {runs.map((run, j) => {
            if (run.family === "drop") return null;
            if (run.family === "box") {
              const box = glyphBox(run.text);
              return box === null ? null : (
                <Formula
                  key={j}
                  box={box}
                  fs={28}
                  marginBottom={0.5 * 28 - box.depthEm * 28}
                />
              );
            }
            return (
              <rp.Text
                key={j}
                style={{
                  fontSize: 28,
                  lineHeight: 1.4,
                  fontFamily: run.family === "base" ? "Times-Roman" : run.family,
                }}
              >
                {run.text}
              </rp.Text>
            );
          })}
        </rp.View>
      ),
    };
  });
  const pdf = await toBuffer(
    <rp.Document>
      <rp.Page size={A4} style={pageStyle}>
        {rows.map((r) => r.node)}
      </rp.Page>
    </rp.Document>,
  );
  fs.writeFileSync(join(OUT, "s8-split-by-coverage.pdf"), pdf);
  const raster = await rasterize(pdf, 1, 2);
  fs_png("s8-split-by-coverage.png", raster.png);
  const missing = (set: Set<number>) =>
    SYMBOLS.filter((s) => !set.has(s.codePointAt(0) ?? 0));
  const result = {
    families: Object.fromEntries(rows.map((r) => [r.symbol, r.families])),
    coverageSizes: {
      main: coverage.main.size,
      ams: coverage.ams.size,
      mathItalic: coverage.mathItalic.size,
    },
    notInMain: missing(coverage.main),
    notInMainOrAms: missing(new Set([...coverage.main, ...coverage.ams])),
  };
  log("S8b", JSON.stringify(result));
  save("results.s8b.json", result);
}

// ---------------------------------------------------------------------------------------------

function runIsolated(
  label: string,
  only: string,
  timeoutMs: number,
  env: Record<string, string> = {},
) {
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? "", `--only=${only}`],
    {
      timeout: timeoutMs,
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: process.cwd(),
    },
  );
  log(
    `[${label}] exit ${String(child.status)} signal ${String(child.signal)} in ${String(ms(started))} ms`,
  );
  log(child.stdout.trim());
  if (child.stderr.trim() !== "") log(child.stderr.trim().slice(0, 600));
}

async function main() {
  rp = await import("@react-pdf/renderer");
  log("react-pdf spike; output in", OUT);
  if (wants("s2")) await stepS2();
  if (wants("s3")) await stepS3();
  if (wants("s4")) await stepS4();
  if (wants("s4c")) await stepS4Heading();
  if (wants("s8")) await stepS8();
  if (wants("s8b")) await stepS8b();
  const over = ONLY?.find((s) => s.startsWith("s4over:"));
  if (over !== undefined) {
    const [, mode, chars] = over.split(":");
    rp.Font.registerHyphenationCallback((word) => [word]);
    await stepS4Oversized(
      mode as "wrapFalse" | "wrapTrue" | "wrapFalseMinPresence",
      Number(chars),
    );
  }
  if (ONLY?.includes("s5")) await stepS5();
  if (ONLY?.includes("s5one")) {
    await stepS5(Number(process.env.S5_COUNT ?? 50), [
      (process.env.S5_KIND ?? "solutions") as "paper",
    ]);
  }
  if (ONLY?.includes("s6")) await stepS6();
  if (ONLY?.includes("fs")) await stepFsLog();
  if (ONLY === null) {
    // Measurements that must not share a process with the steps above (memory, event loop, a
    // render that may misbehave, the first-use initialisation of yoga).
    for (const mode of ["wrapFalse", "wrapTrue", "wrapFalseMinPresence"]) {
      runIsolated(`s4 oversized ${mode} 3000`, `s4over:${mode}:3000`, 90_000);
    }
    runIsolated("s5 worst case (200 items, three documents)", "s5", 300_000);
    for (const count of ["25", "50", "100"]) {
      runIsolated(`s5 scaling, ${count} solutions items`, "s5one", 300_000, {
        S5_COUNT: count,
        S5_KIND: "solutions",
      });
    }
    runIsolated("s6 hostile document, network stubbed", "s6", 120_000);
    runIsolated("s7 fs reads during a render", "fs", 120_000);
  }
}

void main();
