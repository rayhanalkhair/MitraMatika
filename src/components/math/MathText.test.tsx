// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MathText } from "./MathText";

afterEach(cleanup);

describe("MathText", () => {
  it("renders plain text", () => {
    const { container } = render(<MathText text="Hitung hasilnya." />);
    expect(container.textContent).toBe("Hitung hasilnya.");
  });

  it("renders inline math with KaTeX", () => {
    const { container } = render(<MathText text="Nilai $x^2$ ya" />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("Nilai");
  });

  // S-19: a bare comma is a list separator in KaTeX (thin space after it). A decimal comma must
  // render as one number, in the visual output and in the MathML that screen readers use.
  it("renders a decimal comma as one number without list spacing", () => {
    const { container } = render(<MathText text="Hasil $9,60$" />);
    expect(container.querySelector(".mspace")).toBeNull();
    const numbers = container.querySelectorAll(".katex-mathml mn");
    expect(numbers).toHaveLength(1);
    expect(numbers.item(0).textContent).toBe("9,60");
  });

  it("keeps an argument list comma as a list separator", () => {
    const { container } = render(<MathText text="$A(2, 3)$" />);
    expect(container.querySelector(".mspace")).not.toBeNull();
    expect(container.querySelectorAll(".katex-mathml mn")).toHaveLength(2);
  });

  it("renders block math as a block", () => {
    const { container } = render(<MathText text={"$$\\frac{1}{2}$$"} />);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".mfrac")).not.toBeNull();
  });

  // `maxSize` makes KaTeX clamp an oversized box to 10em (it does not throw), so no huge box exists.
  it("bounds an oversized box instead of rendering it", () => {
    const { container } = render(<MathText text={"$\\rule{100000em}{100000em}$"} />);
    const sizes = Array.from(container.querySelectorAll<HTMLElement>("[style]")).flatMap(
      (el) =>
        [
          el.style.width,
          el.style.height,
          el.style.borderRightWidth,
          el.style.borderTopWidth,
        ]
          .map((v) => parseFloat(v))
          .filter((n) => !Number.isNaN(n)),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((n) => n <= 10)).toBe(true);
  });

  it("falls back to the source for runaway macro expansion", () => {
    const text = "$\\def\\a{\\a\\a}\\a$";
    const { container } = render(<MathText text={text} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("shows an escaped dollar as a literal dollar", () => {
    const { container } = render(<MathText text={"Harga \\$5 atau $x$"} />);
    expect(container.textContent).toContain("Harga $5 atau ");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("does not render HTML from text", () => {
    const { container } = render(
      <MathText text={'<img src=x onerror="alert(1)"> <b>tebal</b>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img");
  });

  it("falls back to the source for invalid math", () => {
    const { container } = render(<MathText text={"Coba $\\notacommand{$ lalu"} />);
    expect(container.textContent).toContain("\\notacommand{");
    expect(container.textContent).toContain("$\\notacommand{$");
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("keeps newlines", () => {
    const { container } = render(<MathText text={"baris satu\nbaris dua"} />);
    expect(container.textContent).toContain("\n");
    expect((container.firstElementChild as HTMLElement).style.whiteSpace).toBe(
      "pre-wrap",
    );
  });

  // B-005: the model sometimes writes a unit exponent as plain text outside `$...$`.
  describe("unit exponents outside math", () => {
    const sups = (text: string) =>
      Array.from(render(<MathText text={text} />).container.querySelectorAll("sup")).map(
        (el) => el.textContent,
      );

    it("typesets cm^2 as a superscript and drops the caret", () => {
      const { container } = render(<MathText text="30 cm^2" />);
      expect(container.querySelector("sup")?.textContent).toBe("2");
      expect(container.textContent).toBe("30 cm2");
      expect(container.textContent).not.toContain("^");
      cleanup();
    });

    it("handles m^3, x^2, 10^6 and a negative exponent", () => {
      expect(sups("10 cm^3")).toEqual(["3"]);
      cleanup();
      expect(sups("nilai x^2 positif")).toEqual(["2"]);
      cleanup();
      expect(sups("10^6")).toEqual(["6"]);
      cleanup();
      expect(sups("m^-1")).toEqual(["-1"]);
      cleanup();
    });

    it("leaves math spans alone", () => {
      const { container } = render(
        <MathText text="$24\text{ cm}^2$ dan $x^2$ dan $a_1$" />,
      );
      expect(container.querySelectorAll(".katex")).toHaveLength(3);
      expect(container.querySelectorAll("sup")).toHaveLength(0);
    });

    it("typesets an exponent written without a space after a number", () => {
      expect(sups("24cm^2")).toEqual(["2"]);
      cleanup();
      expect(sups("3x^2")).toEqual(["2"]);
      cleanup();
      expect(render(<MathText text="24cm^2" />).container.textContent).toBe("24cm2");
      cleanup();
    });

    it("does not typeset after a letter or backslash, nor mangle look-alikes", () => {
      expect(sups("abcde^2")).toEqual([]);
      cleanup();
      expect(sups(String.raw`\cm^2`)).toEqual([]);
      cleanup();
      expect(sups("a^b^c")).toEqual([]);
      cleanup();
      expect(sups("budi2@mail.com")).toEqual([]);
      cleanup();
      expect(sups("Luas persegi dihitung dari sisi kali sisi.")).toEqual([]);
      cleanup();
      expect(sups("2^10")).toEqual(["10"]);
      cleanup();
    });

    it("leaves ordinary text with a caret alone", () => {
      expect(sups("a ^ b dan ^2 saja")).toEqual([]);
      cleanup();
    });
  });
});
