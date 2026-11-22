import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import { SMP_CORPUS } from "../../test-fixtures/smp-corpus";
import {
  boxFromContainer,
  createMathCache,
  glyphToMathBox,
  latexToMathBox,
  MathBoxError,
  type LiteAdaptorLike,
  type MathBoxErrorCode,
  type SvgNode,
} from "./math-box";

const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "line"]);
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

function visit(nodes: SvgNode[], fn: (node: SvgNode) => void): void {
  for (const node of nodes) {
    fn(node);
    visit(node.children, fn);
  }
}

function failureOf(source: string, display = false): MathBoxError {
  try {
    latexToMathBox(source, display);
  } catch (error) {
    if (error instanceof MathBoxError) return error;
    throw error;
  }
  throw new Error(`expected a MathBoxError for ${JSON.stringify(source)}`);
}

describe("latexToMathBox: the SMP corpus", () => {
  it("has the 76 formulas", () => {
    expect(SMP_CORPUS).toHaveLength(76);
  });

  // The spike (route B) typeset all 76 in both modes: no expected misses.
  for (const display of [false, true]) {
    it(`typesets every formula (${display ? "display" : "inline"})`, () => {
      for (const source of SMP_CORPUS) {
        const box = latexToMathBox(source, display);
        expect(box.widthEm, source).toBeGreaterThan(0);
        expect(box.heightEm, source).toBeGreaterThan(0);
        expect(box.nodes.length, source).toBeGreaterThan(0);
        visit(box.nodes, (node) => {
          expect(ALLOWED_TAGS.has(node.tag), `${source}: <${node.tag}>`).toBe(true);
          for (const [name, value] of Object.entries(node.attrs)) {
            expect(ALLOWED_ATTRS.has(name), `${source}: ${name}`).toBe(true);
            expect(value, `${source}: ${name}`).not.toMatch(/https?:/i);
          }
        });
      }
    });
  }
});

describe("latexToMathBox: geometry", () => {
  it("gives a fraction depth below the baseline and a letter almost none", () => {
    expect(latexToMathBox(String.raw`\frac{1}{2}`, false).depthEm).toBeGreaterThan(0.1);
    expect(latexToMathBox("x", false).depthEm).toBeLessThan(0.05);
  });

  it("keeps the viewBox consistent with width, height and depth", () => {
    const box = latexToMathBox(String.raw`\frac{1}{2}`, false);
    const [, y, w, h] = box.viewBox;
    expect(box.widthEm).toBeCloseTo(w / 1000);
    expect(box.heightEm).toBeCloseTo(-y / 1000);
    expect(box.depthEm).toBeCloseTo((y + h) / 1000);
  });

  it("draws in black, never currentColor, and never a zero-width stroke", () => {
    const box = latexToMathBox(String.raw`\boxed{x}+\cancel{y}`, false);
    const strokes = new Set<string>();
    visit(box.nodes, (node) => {
      for (const value of Object.values(node.attrs))
        expect(value).not.toBe("currentColor");
      expect(node.attrs["stroke-width"]).not.toBe("0");
      if ("stroke-width" in node.attrs) strokes.add(node.attrs.stroke);
    });
    expect(strokes).toEqual(new Set(["#000000"]));
  });

  it("turns a nested svg (stretchy accent) into a group with a transform", () => {
    const box = latexToMathBox(String.raw`\overrightarrow{AB}`, false);
    let nested = 0;
    const transforms: string[] = [];
    visit(box.nodes, (node) => {
      if (node.tag === "svg") nested++;
      if ("transform" in node.attrs && node.attrs.transform.includes("scale("))
        transforms.push(node.attrs.transform);
    });
    expect(nested).toBe(0);
    expect(transforms.length).toBeGreaterThan(0);
    for (const transform of transforms) expect(transform).not.toMatch(/NaN|undefined/);
  });

  it("applies the decimal comma like the preview", () => {
    expect(latexToMathBox("3,14", false).widthEm).toBeGreaterThan(0);
  });
});

describe("latexToMathBox: refusals", () => {
  const ten = (name: string) => `\\${name}`.repeat(10);
  const refused: Record<string, [string, MathBoxErrorCode]> = {
    "unknown command": [String.raw`\foo{x}`, "parse"],
    href: [String.raw`\href{https://x}{y}`, "unsupported"],
    includegraphics: [String.raw`\includegraphics{x}`, "unsupported"],
    url: [String.raw`\url{https://x.y}`, "unsupported"],
    "expansion bomb": [
      `\\def\\a{x}\\def\\b{${ten("a")}}\\def\\c{${ten("b")}}\\def\\d{${ten("c")}}\\d`,
      "parse",
    ],
    "control character": ["a\u0000b", "parse"],
    backspace: ["a\u0008b", "parse"],
    blank: ["   ", "parse"],
    empty: ["", "parse"],
    "unbalanced brace": [String.raw`\frac{1}{`, "parse"],
    // MathJax draws glyphs outside its font as <text>, which is not on the allowlist.
    "CJK text": [String.raw`\text{中文}`, "unsupported"],
    "emoji text": [String.raw`\text{😀}`, "unsupported"],
  };

  for (const [name, [source, code]] of Object.entries(refused)) {
    it(`refuses ${name} as ${code}, with the fixed message only`, () => {
      const error = failureOf(source);
      expect(error.code).toBe(code);
      // Exactly the fixed message: nothing of the source can be in it.
      expect(error.message).toBe(`math: ${code}`);
    });
  }

  it("reports trust refusals as unsupported", () => {
    expect(failureOf(String.raw`\href{https://x}{y}`).code).toBe("unsupported");
  });

  it("refuses an over-long source as a limit", () => {
    expect(failureOf("x+".repeat(3000)).code).toBe("limit");
  });
});

describe("createMathCache", () => {
  it("returns the same object for the same input and typesets once", () => {
    const spy = vi.spyOn(katex, "renderToString");
    try {
      const cache = createMathCache();
      const first = cache(String.raw`\frac{1}{2}`, false);
      const second = cache(String.raw`\frac{1}{2}`, false);
      expect(second).toBe(first);
      expect(first).not.toBeInstanceOf(Error);
      expect(spy).toHaveBeenCalledTimes(1);
      const display = cache(String.raw`\frac{1}{2}`, true);
      expect(display).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns (and remembers) the error instead of throwing", () => {
    const cache = createMathCache();
    const first = cache(String.raw`\foo{x}`, false);
    expect(first).toBeInstanceOf(MathBoxError);
    expect(cache(String.raw`\foo{x}`, false)).toBe(first);
  });

  it("does not share entries between caches", () => {
    const a = createMathCache()("x", false);
    const b = createMathCache()("x", false);
    expect(a).not.toBe(b);
  });
});

// A fake MathJax output: the branches real output never reaches.
interface FakeNode {
  kind: string;
  attrs?: Record<string, string>;
  children?: FakeNode[];
}
const fakeAdaptor: LiteAdaptorLike = {
  kind: (node) => (node as FakeNode).kind,
  allAttributes: (node) =>
    Object.entries((node as FakeNode).attrs ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  childNodes: (node) => (node as FakeNode).children ?? [],
  textContent: () => "",
};
const container = (...children: FakeNode[]): FakeNode => ({
  kind: "mjx-container",
  children: [{ kind: "svg", attrs: { viewBox: "0 -1000 1000 1500" }, children }],
});
const codeOf = (tree: FakeNode, adaptor = fakeAdaptor): MathBoxErrorCode | "none" => {
  try {
    boxFromContainer(tree, adaptor);
    return "none";
  } catch (error) {
    if (error instanceof MathBoxError) return error.code;
    throw error;
  }
};
const pathNodes = (count: number): FakeNode[] =>
  Array.from({ length: count }, (): FakeNode => ({ kind: "path" }));

describe("boxFromContainer: guards", () => {
  it("accepts a plain tree (the fixture is sound)", () => {
    const tree = container({
      kind: "g",
      children: [{ kind: "path", attrs: { d: "M0 0" } }],
    });
    expect(codeOf(tree)).toBe("none");
  });

  it("refuses an element that is not on the allowlist as unsupported", () => {
    expect(codeOf(container({ kind: "foreignObject" }))).toBe("unsupported");
    expect(codeOf(container({ kind: "text" }))).toBe("unsupported");
  });

  it("refuses an attribute value that holds a URL as unsupported", () => {
    expect(codeOf(container({ kind: "path", attrs: { fill: "http://x/y" } }))).toBe(
      "unsupported",
    );
    expect(codeOf(container({ kind: "g", attrs: { transform: "HTTPS://x" } }))).toBe(
      "unsupported",
    );
  });

  it("drops attributes outside the allowlist instead of copying them", () => {
    const box = boxFromContainer(
      container({ kind: "path", attrs: { d: "M0 0", style: "x", "data-c": "1" } }),
      fakeAdaptor,
    );
    expect(Object.keys(box.nodes[0].attrs)).toEqual(["d"]);
  });

  it("refuses MathJax's merror marker as parse", () => {
    expect(codeOf(container({ kind: "g", attrs: { "data-mml-node": "merror" } }))).toBe(
      "parse",
    );
  });

  it("refuses a formula with too many nodes as limit, and accepts one just under", () => {
    expect(codeOf(container({ kind: "g", children: pathNodes(20_001) }))).toBe("limit");
    expect(codeOf(container({ kind: "g", children: pathNodes(19_990) }))).toBe("none");
  });

  it("turns a RangeError into limit and any other throw into parse, keeping the cause", () => {
    const failing = (error: Error): LiteAdaptorLike => ({
      ...fakeAdaptor,
      allAttributes: () => {
        throw error;
      },
    });
    const tree = container({ kind: "g" });
    expect(
      codeOf(tree, failing(new RangeError("Maximum call stack size exceeded"))),
    ).toBe("limit");
    const cause = new TypeError("secret source text");
    expect(codeOf(tree, failing(cause))).toBe("parse");
    try {
      boxFromContainer(tree, failing(cause));
      expect.unreachable();
    } catch (error) {
      expect((error as MathBoxError).message).toBe("math: parse");
      expect((error as MathBoxError).cause).toBe(cause);
    }
  });

  it("survives nesting deep enough to overflow the stack", () => {
    let deepest: FakeNode = { kind: "path" };
    for (let i = 0; i < 18_000; i++) deepest = { kind: "g", children: [deepest] };
    expect(["limit", "none"]).toContain(codeOf(container(deepest)));
  });
});

describe("cached boxes are frozen", () => {
  it("refuses mutation anywhere in the tree", () => {
    const box = createMathCache()(String.raw`\frac{1}{2}`, false);
    if (box instanceof Error) throw box;
    expect(Object.isFrozen(box)).toBe(true);
    expect(Object.isFrozen(box.viewBox)).toBe(true);
    expect(Object.isFrozen(box.nodes)).toBe(true);
    expect(() => {
      box.widthEm = 0;
    }).toThrow(TypeError);
    expect(() => {
      box.nodes.push({ tag: "g", attrs: {}, children: [] });
    }).toThrow(TypeError);
    let leaf: SvgNode = box.nodes[0];
    while (leaf.children.length > 0) leaf = leaf.children[0];
    expect(Object.isFrozen(leaf)).toBe(true);
    expect(Object.isFrozen(leaf.attrs)).toBe(true);
  });
});

describe("glyphToMathBox", () => {
  it("typesets the operators KaTeX builds from other glyphs (not in, not equal)", () => {
    for (const glyph of ["\u2209", "\u2260", "\u2192"]) {
      const box = glyphToMathBox(glyph);
      expect(box.widthEm, glyph).toBeGreaterThan(0.3);
      expect(box.widthEm, glyph).toBeLessThan(1.5);
      expect(box.nodes.length).toBeGreaterThan(0);
      expect(Object.isFrozen(box)).toBe(true);
    }
  });

  it("returns the same box for the same glyph", () => {
    expect(glyphToMathBox("\u2209")).toBe(glyphToMathBox("\u2209"));
  });

  it("refuses anything but one character in the arrows and operators blocks", () => {
    const refused = ["", "ab", "a", "<", "\u2209\u2260", "\u{1F600}", "\u0000", "\ud800"];
    for (const bad of refused) {
      let code: string | undefined;
      try {
        glyphToMathBox(bad);
      } catch (error) {
        code = (error as MathBoxError).code;
      }
      expect(code, JSON.stringify(bad)).toBe("parse");
    }
  });
});
