import { describe, expect, it } from "vitest";
import { splitMath } from "./split-math";

describe("splitMath", () => {
  it("returns plain text as one segment", () => {
    expect(splitMath("Hitung hasilnya.")).toEqual([
      { kind: "text", value: "Hitung hasilnya." },
    ]);
  });

  it("splits inline and block math from text", () => {
    expect(splitMath("Nilai $x+1$ adalah $$y=2$$ ya")).toEqual([
      { kind: "text", value: "Nilai " },
      { kind: "inline", value: "x+1" },
      { kind: "text", value: " adalah " },
      { kind: "block", value: "y=2" },
      { kind: "text", value: " ya" },
    ]);
  });

  it("keeps an unbalanced dollar sign as text", () => {
    expect(splitMath("Harga $5 saja")).toEqual([
      { kind: "text", value: "Harga $5 saja" },
    ]);
  });

  it("does not let an inline expression span a newline", () => {
    expect(splitMath("a $x\n y$ b").every((s) => s.kind === "text")).toBe(true);
  });

  it("treats an escaped dollar in text as a literal dollar, not a delimiter", () => {
    expect(splitMath("Harga \\$5 atau $x$")).toEqual([
      { kind: "text", value: "Harga $5 atau " },
      { kind: "inline", value: "x" },
    ]);
  });

  it("keeps several escaped dollars in one text segment", () => {
    expect(splitMath("Harga \\$5 dan \\$10")).toEqual([
      { kind: "text", value: "Harga $5 dan $10" },
    ]);
  });

  it("keeps an escaped dollar unchanged inside math", () => {
    expect(splitMath("$a\\$b$")).toEqual([{ kind: "inline", value: "a\\$b" }]);
  });

  // Chosen behaviour: the block alternative needs `$$` at the start, so `$a$$b$` is two inline spans.
  it("splits adjacent inline expressions into two inline segments", () => {
    expect(splitMath("$a$$b$")).toEqual([
      { kind: "inline", value: "a" },
      { kind: "inline", value: "b" },
    ]);
  });

  it("treats a whitespace-only block as a block", () => {
    expect(splitMath("$$ $$")).toEqual([{ kind: "block", value: " " }]);
  });

  it("keeps empty delimiters as text", () => {
    expect(splitMath("$$")).toEqual([{ kind: "text", value: "$$" }]);
    expect(splitMath("$$$$")).toEqual([{ kind: "text", value: "$$$$" }]);
  });

  it("returns nothing for an empty string", () => {
    expect(splitMath("")).toEqual([]);
  });
});
