import katex from "katex";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { parseRich, type RichBlock, type RichRun } from "./rich-blocks";
import { renderRich, type RichContext } from "./rich-text";

const text = (
  value: string,
  style: Partial<RichRun & { kind: "text" }> = {},
): RichRun => ({
  kind: "text",
  text: value,
  bold: false,
  italic: false,
  sup: false,
  ...style,
});
const math = (source: string): RichRun => ({ kind: "math", source });
const para = (...runs: RichRun[]): RichBlock => ({ kind: "paragraph", runs });

describe("parseRich", () => {
  it("reads bold, italic and unit exponents as styled text runs", () => {
    expect(parseRich("a **b** *c* 24 cm^2")).toEqual([
      para(
        text("a "),
        text("b", { bold: true }),
        text(" "),
        text("c", { italic: true }),
        text(" 24 cm"),
        text("2", { sup: true }),
      ),
    ]);
  });

  it("nests italic around bold and a unit exponent inside italic", () => {
    expect(parseRich("*a **b** 3 m^2*")).toEqual([
      para(
        text("a ", { italic: true }),
        text("b", { italic: true, bold: true }),
        text(" 3 m", { italic: true }),
        text("2", { italic: true, sup: true }),
      ),
    ]);
  });

  it("starts a paragraph at a blank line and a break at a newline", () => {
    expect(parseRich("p\n\nq")).toEqual([para(text("p")), para(text("q"))]);
    expect(parseRich("p\nq")).toEqual([para(text("p"), { kind: "break" }, text("q"))]);
    expect(parseRich("p\n\nq", true)).toEqual([
      para(text("p"), { kind: "break" }, text("q")),
    ]);
  });

  it("normalises CRLF and CR line endings", () => {
    expect(parseRich("p\r\n\r\nq\rr")).toEqual([
      para(text("p")),
      para(text("q"), { kind: "break" }, text("r")),
    ]);
  });

  it("keeps inline maths in the paragraph and display maths as a block", () => {
    expect(parseRich("x $a$ $$b$$ y")).toEqual([
      para(text("x "), math("a")),
      { kind: "display", source: "b" },
      para(text("y")),
    ]);
  });

  it("keeps display maths inline in inline mode", () => {
    expect(parseRich("x $a$ $$b$$ y", true)).toEqual([
      para(text("x "), math("a"), text(" "), math("b"), text(" y")),
    ]);
  });

  it("returns nothing for empty or blank text", () => {
    expect(parseRich("")).toEqual([]);
    expect(parseRich(" \n\n \n")).toEqual([]);
    expect(parseRich("   ", true)).toEqual([]);
  });

  it("drops breaks and edge spaces at the ends of a paragraph", () => {
    expect(parseRich("a\n \n\nb\n")).toEqual([para(text("a")), para(text("b"))]);
  });

  it("keeps control characters and markup-like text for the renderer to handle", () => {
    expect(parseRich('a\u0000b <b>x</b> &amp; "q"')).toEqual([
      para(text('a\u0000b <b>x</b> &amp; "q"')),
    ]);
  });

  it("does not read bold, italic or exponents inside maths", () => {
    expect(parseRich("$**a** x^2$")).toEqual([para(math("**a** x^2"))]);
  });

  it("leaves an unbalanced dollar and an escaped dollar as text", () => {
    expect(parseRich("5$ dan 6")).toEqual([para(text("5$ dan 6"))]);
    expect(parseRich(String.raw`harga \$7 dan \$8`)).toEqual([
      para(text("harga $7 dan $8")),
    ]);
  });
});

// Parity with the HTML renderer: both read the maths out of the same text, in the same order,
// in the same mode.
const FIXTURES = [
  "$x$",
  String.raw`a $x$ b $\frac{1}{2}$ c`,
  "$$x^2$$",
  "p $$a$$ q $$b$$ r",
  "one\n\ntwo $x$\n\n$$y$$",
  "line\nbreak $a$\nnext",
  "5$ dan 6$",
  String.raw`harga \$7 dan $x$`,
  String.raw`$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`,
  "**bold $a$** *it $b$*",
  "tanpa rumus",
  "",
  "   ",
  "$a$$b$",
  "$$a$$$$b$$",
  "x $0,5$ y",
  "a\r\nb $c$\r\n\r\n$$d$$",
  String.raw`$\text{kata}$ dan $$\sqrt{2}$$`,
  String.raw`$$
\frac{1}{2}
$$`,
  "24 cm^2 dan $m^2$",
];

describe("parseRich parity with renderRich", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mathSources = (blocks: RichBlock[]): string[] =>
    blocks.flatMap((block) =>
      block.kind === "display"
        ? [block.source]
        : block.runs.flatMap((run) => (run.kind === "math" ? [run.source] : [])),
    );

  it.each([false, true])("hands the same maths to KaTeX (inline: %s)", (inline) => {
    expect(FIXTURES).toHaveLength(20);
    const spy = vi.spyOn(katex, "renderToString");
    for (const md of FIXTURES) {
      spy.mockClear();
      const ctx: RichContext = {
        warnings: [],
        where: { part: "stem" },
        usedMath: false,
      };
      renderRich(md, ctx, inline);
      const rendered = spy.mock.calls.map(([source]) => source);
      expect(
        mathSources(parseRich(md, inline)).map((source) => withDecimalComma(source)),
        md,
      ).toEqual(rendered);
    }
  });
});
