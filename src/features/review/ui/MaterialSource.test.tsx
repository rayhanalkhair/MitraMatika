// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { MaterialSource } from "./MaterialSource";

afterEach(cleanup);

describe("MaterialSource", () => {
  it("names the material and page and links to the page viewer", () => {
    renderWithIntl(
      <MaterialSource
        sources={[{ title: "Buku SPLDV", page: 2, href: "/materials/m1?page=2" }]}
      />,
    );
    const link = screen.getByRole("link", { name: "Sumber: Buku SPLDV, hal. 2" });
    expect(link.getAttribute("href")).toBe("/materials/m1?page=2");
  });

  it('says "Materi sumber telah dihapus" when the material is gone, without a link', () => {
    const { container } = renderWithIntl(
      <MaterialSource sources={[{ title: null, page: 2, href: null }]} />,
    );
    expect(container.textContent).toContain("Materi sumber telah dihapus");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names a trashed material without linking to it", () => {
    const { container } = renderWithIntl(
      <MaterialSource sources={[{ title: "Buku SPLDV", page: 4, href: null }]} />,
    );
    expect(container.textContent).toContain("Sumber: Buku SPLDV, hal. 4");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing for a question without material sources", () => {
    const { container } = renderWithIntl(<MaterialSource sources={[]} />);
    expect(container.textContent).toBe("");
  });
});
