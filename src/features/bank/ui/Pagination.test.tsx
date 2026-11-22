// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { bankQuerySchema } from "../schema/bank-query";
import { Pagination, pageWindow } from "./Pagination";

afterEach(cleanup);

describe("Pagination", () => {
  it("pagination links keep the filters", () => {
    const query = bankQuerySchema.parse({
      grade: "8",
      q: "luas",
      sort: "oldest",
      page: "2",
    });
    renderWithIntl(
      <Pagination
        query={query}
        page={2}
        pageCount={5}
        total={90}
        shown={20}
        pageSize={20}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Halaman Bank Soal" });
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/question-bank?grade=8&q=luas&sort=oldest");
    expect(hrefs).toContain("/question-bank?grade=8&q=luas&sort=oldest&page=3");
    expect(hrefs).toContain("/question-bank?grade=8&q=luas&sort=oldest&page=5");
    expect(
      screen.getByRole("link", { name: "Halaman 2" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText("Menampilkan 21–40 dari 90 soal")).toBeTruthy();
  });

  it("has no navigation for a single page and renders nothing for no results", () => {
    const query = bankQuerySchema.parse({});
    renderWithIntl(
      <Pagination
        query={query}
        page={1}
        pageCount={1}
        total={3}
        shown={3}
        pageSize={20}
      />,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("Menampilkan 1–3 dari 3 soal")).toBeTruthy();
    cleanup();
    const empty = renderWithIntl(
      <Pagination
        query={query}
        page={1}
        pageCount={1}
        total={0}
        shown={0}
        pageSize={20}
      />,
    );
    expect(empty.container.textContent).toBe("");
  });

  it("windows the page numbers with gaps", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(2, 10)).toEqual([1, 2, 3, null, 10]);
  });
});
