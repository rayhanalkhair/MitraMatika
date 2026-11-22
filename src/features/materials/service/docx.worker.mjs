// The whole DOCX extraction for ingestion (Ruling R15): read word/document.xml from the zip, rewrite
// it (equations to LaTeX, breaks to placeholders), let mammoth extract the text and cut it into
// pages. It runs on a worker thread started by docx-text.ts with a heap limit and a hard timeout, so
// a crafted document (deep nesting, a huge part) can neither exhaust the job's memory nor block its
// event loop. Plain JavaScript importing only packages, because the bundler copies this file as an
// asset without bundling it (like pdf.worker.mjs); those packages are traced in next.config.ts.
// ommlToLatex is also imported by omml-to-latex.ts (main thread): the extraction below only runs in
// a worker started with op "docx". It posts exactly one message:
//   { status: "ok", pages, truncated } | { status: "tooLarge" } | { status: "damaged" }
//
// OMML to LaTeX. mammoth drops OMML entirely (extraction spike, result 3). Supported: fractions (bar,
// skewed, linear, no bar), radicals, sub/superscripts and pre-scripts, delimiters, n-ary operators
// (sums, products, integrals), functions, lower/upper limits, bars, accents, boxes, braces (group
// characters), math runs with the common operator, relation, set, arrow and Greek characters, and
// normal-text runs. Anything else (matrices, equation arrays, phantoms, an unknown character where a
// known one is required) makes the whole equation null: the extraction marks it [[?]] and the page
// is flagged uncertain_math rather than storing a guess.
//
// Page model (a DOCX has no fixed pages): a new page starts at every explicit page break
// (<w:br w:type="page"/>) and before every paragraph with w:pageBreakBefore on. Section breaks and
// Word's w:lastRenderedPageBreak hints are ignored. A stretch longer than pageChars is cut into pages
// of at most that size between paragraphs, and a single longer paragraph between words outside any
// $...$ (a hard cut, when no such space exists, still never lands inside an equation). Empty pages
// are dropped; past maxPages the rest is not returned and truncated is true. Placeholders carry a
// random nonce per document, so text in the document cannot imitate them.
import { randomBytes } from "node:crypto";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import JSZip from "jszip";
import mammoth from "mammoth";
import { SaxesParser } from "saxes";

const UNCERTAIN_MARK = "[[?]]";

class Unsupported extends Error {}
const MAX_DEPTH = 64;
/** The local part of a prefixed name (`m:f` -> `f`). */
const local = (name) => name.slice(name.indexOf(":") + 1);
function parse(xml) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  try {
    // Without namespace processing: a fragment cut out of a document need not declare its prefixes.
    const parser = new SaxesParser({ xmlns: false });
    parser.on("error", (error) => {
      throw error;
    });
    parser.on("doctype", () => {
      throw new Unsupported("doctype");
    });
    parser.on("opentag", (tag) => {
      if (stack.length > MAX_DEPTH) throw new Unsupported("depth");
      const attrs = {};
      for (const [name, value] of Object.entries(tag.attributes)) {
        attrs[local(name)] = value;
      }
      const el = { name: local(tag.name), attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    });
    parser.on("closetag", () => {
      stack.pop();
    });
    parser.on("text", (text) => {
      stack[stack.length - 1].children.push(text);
    });
    parser.on("cdata", (text) => {
      stack[stack.length - 1].children.push(text);
    });
    parser.write(xml).close();
  } catch {
    return null;
  }
  const elements = root.children.filter((child) => typeof child !== "string");
  return elements.length === 1 ? elements[0] : null;
}
const elements = (el) => el.children.filter((child) => typeof child !== "string");
const child = (el, name) => elements(el).find((c) => c.name === name);
/** A property's `m:val` (`undefined` when the property is absent). */
function prop(el, container, name) {
  const props = child(el, container);
  const found = props && child(props, name);
  if (!found) return undefined;
  return Object.hasOwn(found.attrs, "val") ? found.attrs.val : "";
}
/** An on/off property: present with no value, or 1/on/true, means on. */
function isOn(el, container, name) {
  const value = prop(el, container, name);
  if (value === undefined) return false;
  return value === "" || value === "1" || value === "on" || value === "true";
}
// Elements that carry formatting only.
const IGNORED = new Set(["bookmarkStart", "bookmarkEnd", "proofErr"]);
const isProperty = (el) => el.name.endsWith("Pr") || IGNORED.has(el.name);
const SYMBOLS = {
  "×": "\\times ",
  "÷": "\\div ",
  "±": "\\pm ",
  "∓": "\\mp ",
  "≤": "\\le ",
  "≥": "\\ge ",
  "≠": "\\neq ",
  "≈": "\\approx ",
  "≡": "\\equiv ",
  "∼": "\\sim ",
  "≅": "\\cong ",
  "∝": "\\propto ",
  "−": "-",
  "·": "\\cdot ",
  "⋅": "\\cdot ",
  "∙": "\\cdot ",
  "∗": "*",
  "…": "\\ldots ",
  "⋯": "\\cdots ",
  "∞": "\\infty ",
  "∂": "\\partial ",
  "∇": "\\nabla ",
  "∈": "\\in ",
  "∉": "\\notin ",
  "⊂": "\\subset ",
  "⊆": "\\subseteq ",
  "⊃": "\\supset ",
  "⊇": "\\supseteq ",
  "∩": "\\cap ",
  "∪": "\\cup ",
  "∅": "\\emptyset ",
  "∀": "\\forall ",
  "∃": "\\exists ",
  "¬": "\\neg ",
  "∧": "\\wedge ",
  "∨": "\\vee ",
  "→": "\\to ",
  "←": "\\leftarrow ",
  "↔": "\\leftrightarrow ",
  "⇒": "\\Rightarrow ",
  "⇔": "\\Leftrightarrow ",
  "∠": "\\angle ",
  "△": "\\triangle ",
  "⊥": "\\perp ",
  "∥": "\\parallel ",
  "°": "^{\\circ}",
  "′": "'",
  "″": "''",
  "√": "\\surd ",
  "∑": "\\sum ",
  "∏": "\\prod ",
  "∫": "\\int ",
  ℝ: "\\mathbb{R}",
  ℕ: "\\mathbb{N}",
  ℤ: "\\mathbb{Z}",
  ℚ: "\\mathbb{Q}",
  ℂ: "\\mathbb{C}",
  "\\": "\\backslash ",
  "{": "\\{",
  "}": "\\}",
  "#": "\\#",
  $: "\\$",
  "%": "\\%",
  "&": "\\&",
  _: "\\_",
  "^": "\\text{\\textasciicircum}",
  "~": "\\sim ",
};
const GREEK =
  "α alpha β beta γ gamma δ delta ε epsilon ζ zeta η eta θ theta ι iota κ kappa λ lambda μ mu ν nu ξ xi π pi ρ rho σ sigma ς varsigma τ tau υ upsilon φ varphi ϕ phi χ chi ψ psi ω omega Γ Gamma Δ Delta Θ Theta Λ Lambda Ξ Xi Π Pi Σ Sigma Φ Phi Ψ Psi Ω Omega".split(
    " ",
  );
for (let i = 0; i < GREEK.length; i += 2) SYMBOLS[GREEK[i]] = `\\${GREEK[i + 1]} `;
/** Mathematical alphanumerics (italic x is U+1D465) and Planck's h stand for plain letters. */
const isMathAlphanumeric = (char) => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1d400 && code <= 0x1d7ff) || code === 0x210e;
};
function mathText(text) {
  let out = "";
  for (const char of text) {
    if (isMathAlphanumeric(char)) out += char.normalize("NFKC");
    else out += SYMBOLS[char] ?? char;
  }
  return out;
}
function plainText(text) {
  return text.replace(/[\\{}#$%&_^~]/g, (char) =>
    char === "\\"
      ? "\\textbackslash{}"
      : char === "^" || char === "~"
        ? `\\textascii${char === "^" ? "circum" : "tilde"}{}`
        : `\\${char}`,
  );
}
const DELIMITERS = {
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "{": "\\{",
  "}": "\\}",
  "|": "|",
  "‖": "\\|",
  "⟨": "\\langle ",
  "⟩": "\\rangle ",
  "⌊": "\\lfloor ",
  "⌋": "\\rfloor ",
  "⌈": "\\lceil ",
  "⌉": "\\rceil ",
  "": ".",
};
const NARY = {
  "∑": "\\sum",
  "∏": "\\prod",
  "∐": "\\coprod",
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⋁": "\\bigvee",
  "⋀": "\\bigwedge",
};
const ACCENTS = {
  "\u0302": "\\hat",
  "\u0303": "\\tilde",
  "\u0304": "\\bar",
  "\u0305": "\\overline",
  "\u20d7": "\\vec",
  "\u0307": "\\dot",
  "\u0308": "\\ddot",
  "\u030c": "\\check",
  "\u0301": "\\acute",
  "\u0300": "\\grave",
  "\u0306": "\\breve",
};
const FUNCTIONS = new Set(
  "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp lim max min sup inf det gcd deg arg dim ker".split(
    " ",
  ),
);
const LIMIT_OPERATORS = new Set(["lim", "max", "min", "sup", "inf"]);
function delimiter(char) {
  const mapped = DELIMITERS[char];
  if (mapped === undefined) throw new Unsupported("delimiter");
  return mapped;
}
/** The converted children of `el` (formatting properties skipped). */
function seq(el) {
  if (!el) return "";
  return elements(el)
    .filter((c) => !isProperty(c))
    .map(convert)
    .join("");
}
const isSingleToken = (latex) => /^([A-Za-z0-9]|\\[A-Za-z]+)$/.test(latex.trim());
/** A script's base: bare when it is one symbol or one bracketed group, else grouped. */
function base(el) {
  const latex = seq(el).trim();
  if (latex === "") return "{}";
  const parts = el ? elements(el).filter((c) => !isProperty(c)) : [];
  if (isSingleToken(latex) || (parts.length === 1 && parts[0].name === "d")) return latex;
  return `{${latex}}`;
}
const group = (latex) => (isSingleToken(latex) ? latex.trim() : `{${latex}}`);
function run(el) {
  let text = "";
  for (const part of elements(el)) {
    if (part.name === "t") {
      text += part.children.filter((c) => typeof c === "string").join("");
    } else if (!isProperty(part)) {
      throw new Unsupported(part.name);
    }
  }
  // A "normal text" run (m:nor) is words, not variables.
  return isOn(el, "rPr", "nor") ? `\\text{${plainText(text)}}` : mathText(text);
}
function convert(el) {
  switch (el.name) {
    case "r":
      return run(el);
    case "oMath":
    case "e":
    case "box":
      return seq(el);
    case "f": {
      const num = seq(child(el, "num"));
      const den = seq(child(el, "den"));
      const type = prop(el, "fPr", "type") ?? "bar";
      if (type === "bar" || type === "skw") return `\\frac{${num}}{${den}}`;
      if (type === "lin") return `${group(num)}/${group(den)}`;
      if (type === "noBar") return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
      throw new Unsupported("fraction type");
    }
    case "rad": {
      const degree = seq(child(el, "deg"));
      const body = seq(child(el, "e"));
      return isOn(el, "radPr", "degHide") || degree.trim() === ""
        ? `\\sqrt{${body}}`
        : `\\sqrt[${degree}]{${body}}`;
    }
    case "sSup":
      return `${base(child(el, "e"))}^{${seq(child(el, "sup"))}}`;
    case "sSub":
      return `${base(child(el, "e"))}_{${seq(child(el, "sub"))}}`;
    case "sSubSup":
      return `${base(child(el, "e"))}_{${seq(child(el, "sub"))}}^{${seq(child(el, "sup"))}}`;
    case "sPre":
      return `{}_{${seq(child(el, "sub"))}}^{${seq(child(el, "sup"))}}${base(child(el, "e"))}`;
    case "d": {
      const open = delimiter(prop(el, "dPr", "begChr") ?? "(");
      const close = delimiter(prop(el, "dPr", "endChr") ?? ")");
      const separator = mathText(prop(el, "dPr", "sepChr") ?? "|");
      const items = elements(el)
        .filter((c) => c.name === "e")
        .map(seq);
      return `\\left${open}${items.join(separator)}\\right${close}`;
    }
    case "nary": {
      const operator = NARY[prop(el, "naryPr", "chr") ?? "∫"];
      if (!operator) throw new Unsupported("n-ary character");
      const sub = seq(child(el, "sub"));
      const sup = seq(child(el, "sup"));
      const lower = !isOn(el, "naryPr", "subHide") && sub.trim() ? `_{${sub}}` : "";
      const upper = !isOn(el, "naryPr", "supHide") && sup.trim() ? `^{${sup}}` : "";
      return `${operator}${lower}${upper}{${seq(child(el, "e"))}}`;
    }
    case "func": {
      const name = seq(child(el, "fName")).trim();
      const head = /^[A-Za-z]+$/.test(name)
        ? FUNCTIONS.has(name)
          ? `\\${name}`
          : `\\operatorname{${name}}`
        : name;
      return `${head}{${seq(child(el, "e"))}}`;
    }
    case "limLow": {
      const body = seq(child(el, "e")).trim();
      const limit = seq(child(el, "lim"));
      return LIMIT_OPERATORS.has(body)
        ? `\\${body}_{${limit}}`
        : `\\underset{${limit}}{${body}}`;
    }
    case "limUpp":
      return `\\overset{${seq(child(el, "lim"))}}{${seq(child(el, "e"))}}`;
    case "bar":
      // ECMA-376: a bar sits below unless its position says top.
      return prop(el, "barPr", "pos") === "top"
        ? `\\overline{${seq(child(el, "e"))}}`
        : `\\underline{${seq(child(el, "e"))}}`;
    case "acc": {
      const accent = ACCENTS[prop(el, "accPr", "chr") ?? "\u0302"];
      if (!accent) throw new Unsupported("accent");
      return `${accent}{${seq(child(el, "e"))}}`;
    }
    case "borderBox":
      return `\\boxed{${seq(child(el, "e"))}}`;
    case "groupChr": {
      const char = prop(el, "groupChrPr", "chr") ?? "\u23df";
      if (char === "\u23df") return `\\underbrace{${seq(child(el, "e"))}}`;
      if (char === "\u23de") return `\\overbrace{${seq(child(el, "e"))}}`;
      throw new Unsupported("group character");
    }
    default:
      // Matrices (m), equation arrays (eqArr), phantoms (phant) and anything unknown.
      throw new Unsupported(el.name);
  }
}
/**
 * One Word equation (`<m:oMath>`, or an `<m:oMathPara>` display block) as LaTeX without `$`
 * delimiters, or null when it holds a construct this converter does not support or is not one
 * well-formed equation.
 */
/**
 * One Word equation (`<m:oMath>`, or an `<m:oMathPara>` display block) as LaTeX without `$`
 * delimiters, or null when it holds a construct this converter does not support or is not one
 * well-formed equation.
 * @param {string} xml
 * @returns {string | null}
 */
export function ommlToLatex(xml) {
  const root = parse(xml);
  if (!root) return null;
  try {
    let latex;
    if (root.name === "oMath") latex = seq(root);
    else if (root.name === "oMathPara") {
      const lines = elements(root)
        .filter((c) => c.name === "oMath")
        .map(seq);
      if (lines.length === 0) return null;
      latex =
        lines.length === 1
          ? lines[0]
          : `\\begin{gathered}${lines.map((line) => line.trim()).join("\\\\")}\\end{gathered}`;
    } else return null;
    return latex.replace(/ {2,}/g, " ").trim();
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

// ---- DOCX ----
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
// Containers whose children are paragraphs: an equation directly inside one gets a paragraph.
const BLOCKS = new Set([
  "body",
  "tc",
  "txbxContent",
  "footnote",
  "endnote",
  "comment",
  "hdr",
  "ftr",
]);
const PAGE = "\f";
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const escapeText = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text) =>
  escapeText(text)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
function openTag(tag) {
  const attributes = Object.values(tag.attributes)
    .map((attribute) => ` ${attribute.name}="${escapeAttr(attribute.value)}"`)
    .join("");
  return `<${tag.name}${attributes}>`;
}
const isOnTag = (tag) => {
  const value = Object.values(tag.attributes).find((a) => a.local === "val")?.value;
  return value === undefined || !["0", "false", "off"].includes(value);
};
function placeholders() {
  const nonce = randomBytes(12).toString("hex");
  return {
    equation: (index) => `MMEQ${nonce}X${String(index)}X`,
    equationPattern: new RegExp(`MMEQ${nonce}X(\\d+)X`, "g"),
    page: `MMPB${nonce}`,
  };
}
/** word/document.xml with equations and breaks replaced by placeholders, or null if malformed. */
function rewrite(xml, marks, maxDepth) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  const equations = [];
  const stack = [];
  let capture = null;
  let breakAfterProperties = false;
  let wPrefix = null;
  const w = (name) => (wPrefix ? `${wPrefix}:${name}` : name);
  const textRun = (text) =>
    `<${w("r")}><${w("t")} xml:space="preserve">${text}</${w("t")}></${w("r")}>`;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on("error", (error) => {
      throw error;
    });
    parser.on("doctype", () => {
      throw new Error("a DTD is not allowed");
    });
    parser.on("opentag", (tag) => {
      // Deep nesting is what makes a small document expensive to read: refuse it early.
      if (stack.length + (capture ? capture.depth : 0) >= maxDepth) {
        throw new Error("nested too deeply");
      }
      if (capture) {
        capture.depth += 1;
        capture.names.push(tag.local);
        capture.parts.push(openTag(tag));
        return;
      }
      if (wPrefix === null && tag.uri === W) wPrefix = tag.prefix;
      if (tag.uri === M && (tag.local === "oMath" || tag.local === "oMathPara")) {
        capture = {
          depth: 1,
          display: tag.local === "oMathPara",
          parts: [openTag(tag)],
          names: [tag.local],
          plain: [],
        };
        stack.push({ uri: tag.uri, local: tag.local, skip: true });
        return;
      }
      if (tag.uri === W && (tag.local === "br" || tag.local === "cr")) {
        const type = Object.values(tag.attributes).find((a) => a.local === "type")?.value;
        out.push(
          tag.local === "br" && type === "page"
            ? `<${w("t")}>${marks.page}</${w("t")}>`
            : `<${w("t")} xml:space="preserve">&#10;</${w("t")}>`,
        );
        stack.push({ uri: tag.uri, local: tag.local, skip: true });
        return;
      }
      if (tag.uri === W && tag.local === "pageBreakBefore" && isOnTag(tag)) {
        breakAfterProperties = true;
      }
      out.push(openTag(tag));
      stack.push({ uri: tag.uri, local: tag.local, skip: false });
    });
    parser.on("closetag", (tag) => {
      if (capture && capture.depth > 1) {
        capture.depth -= 1;
        capture.names.pop();
        capture.parts.push(`</${tag.name}>`);
        return;
      }
      const frame = stack.pop();
      if (capture) {
        capture.parts.push(`</${tag.name}>`);
        const latex = ommlToLatex(capture.parts.join(""));
        const plain = capture.plain.join(" ").replace(/\s+/g, " ").trim();
        let text;
        if (latex === null) text = `${UNCERTAIN_MARK}${plain}${UNCERTAIN_MARK}`;
        else if (latex === "") text = "";
        else text = capture.display ? `$$${latex}$$` : `$${latex}$`;
        const run = textRun(marks.equation(equations.length));
        equations.push(text);
        const parent = stack.at(-1);
        out.push(
          parent?.uri === W && BLOCKS.has(parent.local)
            ? `<${w("p")}>${run}</${w("p")}>`
            : run,
        );
        capture = null;
        return;
      }
      if (frame?.skip) return;
      out.push(`</${tag.name}>`);
      if (tag.uri === W && tag.local === "pPr" && breakAfterProperties) {
        out.push(textRun(marks.page));
        breakAfterProperties = false;
      }
    });
    const onText = (text) => {
      if (capture) {
        if (capture.names.at(-1) === "t") capture.plain.push(text);
        capture.parts.push(escapeText(text));
      } else out.push(escapeText(text));
    };
    parser.on("text", onText);
    parser.on("cdata", onText);
    parser.write(xml).close();
  } catch {
    return null;
  }
  return { xml: out.join(""), equations };
}
/** Reads one entry inflating at most `max` bytes; null when it is larger. */
function readEntry(file, max) {
  return new Promise((resolve, reject) => {
    const stream = file.nodeStream("nodebuffer");
    const chunks = [];
    let total = 0;
    let settled = false;
    stream.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        settled = true;
        stream.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/^\ufeff/, ""),
      );
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
// Equations as the extraction writes them: $$...$$ or $...$ (a backslash escapes the next character).
const MATH = /\$\$(?:\\[\s\S]|[^\\$])*\$\$|\$(?:\\[\s\S]|[^\\$])*\$/g;

/** The equation around `index` (start < index < end), if any. */
function mathAt(text, index) {
  for (const match of text.matchAll(MATH)) {
    if (match.index >= index) return null;
    const end = match.index + match[0].length;
    if (index < end) return { start: match.index, end };
  }
  return null;
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

/** Cuts one paragraph longer than a page between words, never inside an equation. */
function cutParagraph(paragraph, pageChars) {
  const parts = [];
  let rest = paragraph;
  while (rest.length > pageChars) {
    let cut = -1;
    for (let i = pageChars; i > 0; i -= 1) {
      if (/\s/.test(rest[i]) && !mathAt(rest, i)) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) {
      // No such space (one huge word or equation): cut hard, but around an equation and never
      // between the halves of a surrogate pair.
      cut = pageChars;
      const math = mathAt(rest, cut);
      if (math) cut = math.start > 0 ? math.start : math.end;
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  return parts.filter((part) => part !== "");
}

/** One stretch between page breaks as pages of at most pageChars, whole paragraphs. */
function paginate(stretch, pageChars) {
  const pages = [];
  let page = "";
  for (const paragraph of stretch.split(/\n{2,}/).map((p) => p.trim())) {
    if (paragraph === "") continue;
    for (const part of cutParagraph(paragraph, pageChars)) {
      if (page && page.length + 2 + part.length > pageChars) {
        pages.push(page);
        page = "";
      }
      page = page ? `${page}\n\n${part}` : part;
    }
  }
  if (page) pages.push(page);
  return pages;
}

async function extract(bytes, limits) {
  const marks = placeholders();
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file("word/document.xml");
  if (!part) return { status: "damaged" };
  const xml = await readEntry(part, limits.maxXmlBytes);
  if (xml === null) return { status: "tooLarge" };
  const rewritten = rewrite(xml, marks, limits.maxDepth);
  if (!rewritten) return { status: "damaged" };

  // mammoth reads a minimal package holding only the rewritten part.
  const minimal = new JSZip();
  minimal.file("[Content_Types].xml", CONTENT_TYPES);
  minimal.file("_rels/.rels", RELS);
  minimal.file("word/document.xml", rewritten.xml);
  const buffer = await minimal.generateAsync({ type: "nodebuffer" });
  const raw = (await mammoth.extractRawText({ buffer })).value;

  const text = raw
    .replace(
      marks.equationPattern,
      (_, index) => rewritten.equations[Number(index)] ?? "",
    )
    .split(marks.page)
    .join(PAGE);
  const pages = text
    .split(PAGE)
    .flatMap((stretch) => paginate(stretch, limits.pageChars));
  return {
    status: "ok",
    pages: pages.slice(0, limits.maxPages),
    truncated: pages.length > limits.maxPages,
  };
}

if (!isMainThread && parentPort && workerData?.op === "docx") {
  const port = parentPort;
  void (async () => {
    let answer;
    try {
      answer = await extract(new Uint8Array(workerData.bytes), workerData.limits);
    } catch {
      answer = { status: "damaged" };
    }
    port.postMessage(answer);
  })();
}
