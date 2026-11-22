// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PageContainer } from "./PageContainer";

afterEach(cleanup);

describe("PageContainer", () => {
  it("default width has max-w-7xl and narrow has max-w-3xl", () => {
    const { container, rerender } = render(<PageContainer>x</PageContainer>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("max-w-7xl");
    expect(el.className).toContain("mx-auto");
    expect(el.className).toContain("w-full");
    expect(el.className).toContain("min-w-0");
    expect(el.className).toContain("px-4");
    expect(el.className).toContain("sm:px-8");
    rerender(<PageContainer width="narrow">x</PageContainer>);
    const narrow = container.firstElementChild as HTMLElement;
    expect(narrow.className).toContain("max-w-3xl");
    expect(narrow.className).not.toContain("max-w-7xl");
  });

  it("merges a className and adds no landmark", () => {
    const { container } = render(<PageContainer className="extra">x</PageContainer>);
    expect((container.firstElementChild as HTMLElement).className).toContain("extra");
    expect(container.querySelector("main, header, nav, aside, section")).toBeNull();
  });
});
