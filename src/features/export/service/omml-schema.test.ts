// Schema conformance of the equations: what Word's OMML schema (ECMA-376 part 1, shared-math)
// requires of the elements mathml2omml writes, checked over a corpus of SMP formulas. Word opened
// through automation with alerts off does not report a repair, so these structural checks are the
// evidence (the owner's visible Word check covers the rest).
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { SMP_CORPUS } from "../test-fixtures/smp-corpus";
import { latexToOmml } from "./latex-to-omml";

interface Node {
  name: string;
  attributes: Record<string, string>;
  children: (Node | string)[];
}

function parse(xml: string): Node {
  const stack: Node[] = [];
  const roots: Node[] = [];
  const parser = new SaxesParser();
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (tag) => {
    const node: Node = {
      name: tag.name,
      attributes: { ...tag.attributes },
      children: [],
    };
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  parser.on("text", (text) => {
    if (stack.length > 0) stack[stack.length - 1].children.push(text);
  });
  parser.on("closetag", () => stack.pop());
  parser.write(xml).close();
  const [root] = roots;
  return root;
}

const elements = (node: Node) =>
  node.children.filter((c): c is Node => typeof c !== "string");
function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of elements(node)) yield* walk(child);
}

const STYLES = new Set(["p", "b", "i", "bi"]);
// CT_OMathArg: the argument elements whose first child may be one m:argPr.
const ARGUMENTS = new Set([
  "m:e",
  "m:num",
  "m:den",
  "m:sub",
  "m:sup",
  "m:deg",
  "m:lim",
  "m:fName",
]);

/** Every schema problem found in one equation, as readable strings. */
function schemaProblems(omml: string): string[] {
  const problems: string[] = [];
  for (const node of walk(parse(omml))) {
    const kids = elements(node);
    const names = kids.map((k) => k.name);
    if (node.name === "m:sty" && !STYLES.has(node.attributes["m:val"] ?? "")) {
      problems.push(`m:sty m:val="${node.attributes["m:val"] ?? ""}"`);
    }
    if (node.name === "m:rPr" && names.includes("m:nor") && names.includes("m:sty")) {
      problems.push("m:nor together with m:sty");
    }
    if (node.name === "m:r") {
      // CT_R: m:rPr?, w:rPr?, then the content.
      const rank = (name: string) => (name === "m:rPr" ? 0 : name === "w:rPr" ? 1 : 2);
      const ranks = names.map(rank);
      if (ranks.some((r, i) => i > 0 && r < ranks[i - 1]))
        problems.push(`m:r order ${names.join(",")}`);
      if (names.filter((n) => n === "m:rPr").length > 1) problems.push("two m:rPr");
      if (names.filter((n) => n === "w:rPr").length > 1) problems.push("two w:rPr");
      for (const k of kids) {
        if (k.name === "w:rPr" && k.children.length === 0) problems.push("empty w:rPr");
      }
    }
    if (ARGUMENTS.has(node.name)) {
      const count = names.filter((n) => n === "m:argPr").length;
      if (count > 1) problems.push(`${node.name} with ${String(count)} m:argPr`);
      if (count === 1 && names[0] !== "m:argPr")
        problems.push(`${node.name} m:argPr not first`);
    }
  }
  return problems;
}

const mathText = (omml: string) =>
  [...walk(parse(omml))]
    .filter((n) => n.name === "m:t")
    .map((n) => n.children.filter((c) => typeof c === "string").join(""))
    .join("");

describe("OMML schema conformance over the SMP corpus", () => {
  it("has the 76 corpus formulas", () => {
    expect(SMP_CORPUS).toHaveLength(76);
  });

  it.each(SMP_CORPUS)("%s converts to schema-valid OMML", (latex) => {
    const omml = latexToOmml(withDecimalComma(latex));
    expect(schemaProblems(omml)).toEqual([]);
  });

  it("finds the problems mathml2omml writes on its own (the checker works)", () => {
    const raw =
      '<m:oMath xmlns:m="m" xmlns:w="w"><m:r><w:rPr/><m:rPr><m:nor/><m:sty m:val="undefined"/></m:rPr><m:t>%</m:t></m:r>' +
      "<m:m><m:mr><m:e><m:argPr/><m:argPr/><m:r><m:t>x</m:t></m:r></m:e></m:mr></m:m></m:oMath>";
    expect(schemaProblems(raw)).toEqual([
      "m:r order w:rPr,m:rPr,m:t",
      "empty w:rPr",
      "m:nor together with m:sty",
      'm:sty m:val="undefined"',
      "m:e with 2 m:argPr",
    ]);
  });

  it("keeps the symbols of the normalised runs", () => {
    expect(mathText(latexToOmml("25\\%"))).toBe("25%");
    expect(mathText(latexToOmml("x \\neq 4"))).toBe("x≠4");
    expect(mathText(latexToOmml("\\infty"))).toBe("∞");
    expect(mathText(latexToOmml("\\mathrm{kg}"))).toBe("kg");
  });

  it("keeps bold from \\mathbf as w:b after m:rPr", () => {
    const omml = latexToOmml("\\mathbf{v}");
    expect(schemaProblems(omml)).toEqual([]);
    expect(omml).toMatch(
      /<m:r><m:rPr>.*<\/m:rPr><w:rPr><w:b\/><\/w:rPr><m:t[^>]*>v<\/m:t>/,
    );
  });
});

describe("constructs mathml2omml maps wrongly", () => {
  it("\\binom has no fraction bar, \\frac keeps it", () => {
    const binom = parse(latexToOmml("\\binom{n}{k}"));
    const types = [...walk(binom)]
      .filter((n) => n.name === "m:type")
      .map((n) => n.attributes["m:val"]);
    expect(types).toEqual(["noBar"]);
    const mixed = parse(latexToOmml("\\frac{a}{b} + \\binom{n}{k} + \\dfrac{c}{d}"));
    expect(
      [...walk(mixed)]
        .filter((n) => n.name === "m:type")
        .map((n) => n.attributes["m:val"]),
    ).toEqual(["bar", "noBar", "bar"]);
  });

  it("\\underline is a line under the base, \\overline stays an overline", () => {
    const under = latexToOmml("\\underline{x}");
    expect(under).not.toContain("<m:acc>");
    const box = [...walk(parse(under))].find((n) => n.name === "m:borderBox");
    expect(box).toBeDefined();
    const hidden = [...walk(box!)]
      .filter((n) => n.name.startsWith("m:hide"))
      .map((n) => n.name);
    expect(hidden).toEqual(["m:hideTop", "m:hideLeft", "m:hideRight"]);
    expect(mathText(under)).toBe("x");
    expect(latexToOmml("\\overline{AB}")).toContain("<m:acc>");
  });

  it("\\mathbb letters become the double-struck characters", () => {
    expect(mathText(latexToOmml("\\mathbb{R}"))).toBe("ℝ");
    expect(mathText(latexToOmml("\\mathbb{N} \\subset \\mathbb{Z}"))).toBe("ℕ⊂ℤ");
    expect(mathText(latexToOmml("\\mathbb{A}"))).toBe("\u{1D538}");
  });
});
