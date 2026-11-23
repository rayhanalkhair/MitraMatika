import { describe, expect, it } from "vitest";
import { normalizeAiText, unescapeLiteralBreaks } from "./normalize-ai-text";

describe("normalizeAiText: literal escapes outside maths", () => {
  it("turns a backslash-n between display formulas into a real line break (S-10 solver shape)", () => {
    const raw = String.raw`Kurangkan 3 dari kedua sisi:\n$$2x = 11 - 3$$\n$$2x = 8$$`;
    expect(normalizeAiText(raw)).toBe(
      "Kurangkan 3 dari kedua sisi:\n$$2x = 11 - 3$$\n$$2x = 8$$",
    );
  });

  it("handles inline formulas, \\r\\n and \\t in prose", () => {
    expect(normalizeAiText(String.raw`a\r\nb\nc $x$\n$y$`)).toBe("a\nb\nc $x$\n$y$");
    expect(normalizeAiText(String.raw`kolom\tkolom`)).toBe("kolom kolom");
  });

  it("leaves real line breaks, plain text and other backslashes alone", () => {
    expect(normalizeAiText("a\nb")).toBe("a\nb");
    expect(normalizeAiText("tanpa escape")).toBe("tanpa escape");
    expect(normalizeAiText(String.raw`C:\\new`)).toBe(String.raw`C:\\new`);
    expect(normalizeAiText("")).toBe("");
  });

  it.each([
    String.raw`$a \neq b$`,
    String.raw`$\nabla f$`,
    String.raw`$\nu = 2$`,
    String.raw`$\natural$`,
    String.raw`$x \not= y$`,
    String.raw`$a \newline b$`,
    String.raw`$$\begin{aligned} a &= 1 \newline b &= 2 \end{aligned}$$`,
    String.raw`$\notin A \ne B \neg p \ni x \nmid y \ncong z$`,
    String.raw`$$\nu \neq \nabla$$`,
    String.raw`\$5 dan $\neq$`,
  ])("does not touch the LaTeX command in %s", (math) => {
    expect(normalizeAiText(math)).toBe(math);
  });

  it("converts the text around a formula whose commands start with n, and keeps the formula", () => {
    const raw = String.raw`Karena $a \neq b$,\nmaka $\nu \ne 0$\n$$\nabla x$$`;
    expect(normalizeAiText(raw)).toBe(
      String.raw`Karena $a \neq b$,` +
        "\n" +
        String.raw`maka $\nu \ne 0$` +
        "\n" +
        String.raw`$$\nabla x$$`,
    );
  });

  it("is idempotent", () => {
    const raw = String.raw`a\n$\neq$\n$$\nu$$\tb`;
    const once = normalizeAiText(raw);
    expect(normalizeAiText(once)).toBe(once);
  });
});

describe("unescapeLiteralBreaks (a text segment, no maths in it)", () => {
  it("converts only the escapes", () => {
    expect(unescapeLiteralBreaks(String.raw`satu\ndua\r\ntiga\tempat`)).toBe(
      "satu\ndua\ntiga empat",
    );
    expect(unescapeLiteralBreaks(String.raw`\\n tetap`)).toBe(String.raw`\\n tetap`);
  });
});

describe("bare LaTeX commands outside any delimiter", () => {
  it.each([
    String.raw`\text{cm}`,
    String.raw`3 \times 4`,
    String.raw`\theta dan \neq`,
    String.raw`\nu`,
  ])("keeps %s (a command, not an escape)", (text) => {
    expect(normalizeAiText(text)).toBe(text);
    expect(unescapeLiteralBreaks(text)).toBe(text);
  });

  it("still converts an escape that is followed by a word", () => {
    expect(normalizeAiText(String.raw`Langkah 1:\nLangkah 2:\nuntuk x`)).toBe(
      ["Langkah 1:", "Langkah 2:", "untuk x"].join("\n"),
    );
    expect(normalizeAiText(String.raw`a\tb`)).toBe("a b");
  });
});
