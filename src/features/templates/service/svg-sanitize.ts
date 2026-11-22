import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { err, ok, type Result } from "@/lib/result";

// An allowlist rebuild of an uploaded SVG logo. The file is parsed with a strict XML parser
// (saxes: no DTD processing, only the five predefined entities) and a new document is written
// from the elements and attributes below; everything else is dropped. A DOCTYPE is refused
// outright, so no entity can expand (billion laughs) or reach outside (XXE).

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export const MAX_SVG_ELEMENTS = 5000;
export const MAX_SVG_DEPTH = 100;

// Static drawing only: no script, foreignObject, image, a, style, animation, filter or font.
// Anything else is dropped together with its content.
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "symbol",
  "use",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
]);

// Geometry and presentation attributes. No event handler (on*), no style, no class.
const ATTRIBUTES = new Set([
  "id",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "version",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "word-spacing",
  "visibility",
  "display",
  "vector-effect",
  "paint-order",
  "shape-rendering",
  "text-rendering",
]);

// Only these may reference something, and only an element of the same document.
const HREF_ELEMENTS = new Set(["use", "linearGradient", "radialGradient"]);
const FRAGMENT = /^#[A-Za-z_][\w.-]*$/;
const LOCAL_URL = /url\(\s*#[A-Za-z_][\w.-]*\s*\)/gi;
const UNSAFE_VALUE = /url\s*\(|\\|(?:javascript|vbscript|data)\s*:|expression\s*\(/i;

class Refused extends Error {}

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;");

const isSvgElement = (node: SaxesTagNS) =>
  (node.uri === SVG_NS || node.uri === "") && ELEMENTS.has(node.local);

/** The attribute as it may be written out, or null to drop it. */
function safeAttribute(
  element: string,
  attribute: SaxesAttributeNS,
): [string, string] | null {
  const { local, uri, value } = attribute;
  if (local === "href" && (uri === "" || uri === XLINK_NS)) {
    return HREF_ELEMENTS.has(element) && FRAGMENT.test(value.trim())
      ? ["href", value.trim()]
      : null;
  }
  if (uri !== "" || !ATTRIBUTES.has(local)) return null;
  // url(#id) is the only reference allowed in a value; anything else that could load or run
  // something drops the attribute.
  if (UNSAFE_VALUE.test(value.replace(LOCAL_URL, ""))) return null;
  return [local, value];
}

/**
 * Rebuilds the SVG from an allowlist of elements and attributes. Refuses (invalidImage) a
 * DOCTYPE, malformed XML, an unknown entity, a root other than <svg>, more than
 * MAX_SVG_ELEMENTS elements or nesting deeper than MAX_SVG_DEPTH.
 */
export function sanitizeSvg(source: string): Result<string, "invalidImage"> {
  const parser = new SaxesParser({ xmlns: true });
  const out: string[] = [];
  // For each open element: whether it was written (true) or is being dropped (false).
  const stack: boolean[] = [];
  let dropping = 0;
  let elements = 0;
  const seen = { root: false };

  parser.on("doctype", () => {
    throw new Refused("doctype");
  });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (node) => {
    elements += 1;
    if (elements > MAX_SVG_ELEMENTS || stack.length >= MAX_SVG_DEPTH) {
      throw new Refused("too large");
    }
    if (!seen.root) {
      seen.root = true;
      if (!isSvgElement(node) || node.local !== "svg") throw new Refused("root");
    }
    if (dropping > 0 || !isSvgElement(node)) {
      dropping += 1;
      stack.push(false);
      return;
    }
    const parts = [`<${node.local}`];
    if (stack.length === 0) parts.push(` xmlns="${SVG_NS}"`);
    for (const attribute of Object.values(node.attributes)) {
      const safe = safeAttribute(node.local, attribute);
      if (safe) parts.push(` ${safe[0]}="${escapeAttribute(safe[1])}"`);
    }
    parts.push(node.isSelfClosing ? "/>" : ">");
    out.push(parts.join(""));
    stack.push(true);
  });
  parser.on("closetag", (node) => {
    const written = stack.pop();
    if (!written) {
      dropping -= 1;
      return;
    }
    if (!node.isSelfClosing) out.push(`</${node.local}>`);
  });
  const onText = (text: string) => {
    if (dropping === 0 && stack.length > 0) out.push(escapeText(text));
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  // Comments, processing instructions and the XML declaration are not written.

  try {
    // trimStart also drops a byte order mark (U+FEFF counts as white space).
    parser.write(source.trimStart()).close();
  } catch {
    return err("invalidImage");
  }
  // Empty when there was no root element at all.
  if (out.length === 0) return err("invalidImage");
  return ok(out.join(""));
}
