// Small XML and text helpers shared by the HTML and Word renderers.
import { SaxesParser } from "saxes";

/** A parsed XML element: qualified names as written, decoded text and attribute values. */
export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: (XmlNode | string)[];
}

/** One well-formed XML element as a tree (namespace prefixes kept as written); throws otherwise. */
export function parseXml(xml: string): XmlNode {
  const stack: XmlNode[] = [];
  const roots: XmlNode[] = [];
  let failure: unknown = null;
  const parser = new SaxesParser();
  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.on("opentag", (tag) => {
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...tag.attributes },
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  parser.on("text", (text) => {
    stack.at(-1)?.children.push(text);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (failure !== null) throw failure as Error;
  const root = roots.at(0);
  if (!root || roots.length > 1) throw new Error("xml: expected one root element");
  return root;
}

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

/** The tree back to XML, escaping every text node and attribute value. */
export function serializeXml(node: XmlNode): string {
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  const inner = node.children
    .map((child) => (typeof child === "string" ? escapeText(child) : serializeXml(child)))
    .join("");
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

/** The element children of a node. */
export const childElements = (node: XmlNode): XmlNode[] =>
  node.children.filter((child): child is XmlNode => typeof child !== "string");

/** The text of a node and its descendants, decoded. */
export const textOf = (node: XmlNode): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");

/** The node and all its descendant elements, in document order. */
export function* descendants(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const child of childElements(node)) yield* descendants(child);
}

/**
 * One character that XML 1.0 does not allow (C0 controls other than tab, LF and CR, U+FFFE/U+FFFF
 * and lone surrogates). Built from an escaped string so the ranges stay visible in the source.
 */
export const NOT_XML_CHAR = new RegExp(
  "[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]",
  "u",
);
const NOT_XML_GLOBAL = new RegExp(NOT_XML_CHAR.source, "gu");

/** Drops the characters XML 1.0 forbids. */
export const xmlSafe = (text: string): string => text.replace(NOT_XML_GLOBAL, "");

/**
 * At most `max` code points (never half a surrogate pair, which jsonb refuses), with "..." when
 * something was cut.
 */
export function cutText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join("")}...` : text;
}
