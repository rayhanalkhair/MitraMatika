// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader", () => {
  it("renders one h1 with the title", () => {
    render(<PageHeader title="Beranda" />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Beranda" })).toBeTruthy();
  });

  it("renders description, eyebrow and actions when given", () => {
    render(
      <PageHeader
        title="Beranda"
        description="Ringkasan"
        eyebrow="Guru"
        status={<span>Siap</span>}
        actions={<button type="button">Buat</button>}
      />,
    );
    expect(screen.getByText("Ringkasan")).toBeTruthy();
    expect(screen.getByText("Guru")).toBeTruthy();
    expect(screen.getByText("Siap")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buat" })).toBeTruthy();
  });

  it("omits the optional parts when not given", () => {
    const { container } = render(<PageHeader title="Beranda" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(container.querySelector("button")).toBeNull();
  });

  it("lets a long single-word title wrap instead of overflowing", () => {
    const title = "a".repeat(40);
    render(<PageHeader title={title} />);
    const h1 = screen.getByRole("heading", { level: 1, name: title });
    expect(h1.className).toContain("break-words");
    expect(h1.parentElement?.className).toContain("min-w-0");
  });

  it("adds no landmark", () => {
    const { container } = render(<PageHeader title="Beranda" actions={<span>a</span>} />);
    expect(container.querySelector("main, header, nav, aside, section")).toBeNull();
  });
});
