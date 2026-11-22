// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { bankQuerySchema } from "../schema/bank-query";
import { ActiveFilters, BankFilters, type BankFacets } from "./BankFilters";

// jsdom has no matchMedia; the sheet listens for the viewport growing to the lg breakpoint.
type WideListener = (event: { matches: boolean }) => void;
let wideListeners: WideListener[] = [];
beforeEach(() => {
  wideListeners = [];
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_: string, fn: WideListener) => wideListeners.push(fn),
    removeEventListener: (_: string, fn: WideListener) => {
      wideListeners = wideListeners.filter((x) => x !== fn);
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ELEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOPIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const facets: BankFacets = {
  grades: [7, 8],
  elements: [{ id: ELEMENT, name: "Geometri" }],
  topics: [{ id: TOPIC, title: "Teorema Pythagoras" }],
};

describe("BankFilters", () => {
  it("filters render the facets and write the URL query", () => {
    const query = bankQuerySchema.parse({ grade: "8", q: "luas", sort: "oldest" });
    renderWithIntl(<BankFilters query={query} facets={facets} />);
    const grade = screen.getByLabelText<HTMLSelectElement>("Kelas");
    expect([...grade.options].map((o) => o.textContent)).toEqual([
      "Semua",
      "Kelas 7",
      "Kelas 8",
    ]);
    expect(grade.value).toBe("8");
    expect(screen.getByLabelText("Elemen")).toBeTruthy();
    expect(screen.getByLabelText("Topik")).toBeTruthy();
    expect(screen.getByLabelText("Tingkat kesulitan")).toBeTruthy();
    expect(screen.getByLabelText("Status verifikasi")).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>("Urutkan").value).toBe("oldest");

    const form = grade.closest("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/question-bank");
    // Empty controls are left out of the query; the search text and the choices are kept.
    fireEvent.submit(form);
    const data = new FormData(form);
    expect([...data.keys()].sort()).toEqual(["grade", "q", "sort"]);
    expect(data.get("q")).toBe("luas");
  });

  it("mobile shows a Filter button that opens a sheet", () => {
    renderWithIntl(<BankFilters query={bankQuerySchema.parse({})} facets={facets} />);
    const button = screen.getByRole("button", { name: "Filter" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    const sheet = screen.getByRole("dialog", { name: "Filter" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByLabelText("Kelas")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Tutup filter" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape closes it too, and focus goes back to the button.
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("BankFilters sheet", () => {
  it("moves focus into the sheet when a search is active", () => {
    const query = bankQuerySchema.parse({ q: "luas" });
    renderWithIntl(<BankFilters query={query} facets={facets} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const sheet = screen.getByRole("dialog", { name: "Filter" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Kelas"));
  });

  it("closes when the viewport grows to the inline layout", () => {
    renderWithIntl(<BankFilters query={bankQuerySchema.parse({})} facets={facets} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => {
      for (const fn of wideListeners) fn({ matches: true });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps origin and type, and the search, when the filters are applied", () => {
    const query = bankQuerySchema.parse({
      origin: "manual",
      type: "multiple_choice",
      q: "luas",
    });
    renderWithIntl(<BankFilters query={query} facets={facets} />);
    const form = screen.getByLabelText<HTMLSelectElement>("Kelas").closest("form")!;
    fireEvent.submit(form);
    const data = new FormData(form);
    expect(data.get("origin")).toBe("manual");
    expect(data.get("type")).toBe("multiple_choice");
    expect(data.get("q")).toBe("luas");
  });
});

describe("ActiveFilters", () => {
  it("active filters show as removable pills and reset clears them", () => {
    const query = bankQuerySchema.parse({
      grade: "8",
      elementId: ELEMENT,
      difficulty: "sulit",
      q: "luas",
      sort: "oldest",
    });
    renderWithIntl(<ActiveFilters query={query} facets={facets} />);
    const group = screen.getByRole("group", { name: "Filter aktif" });
    const hrefOf = (name: string) =>
      screen.getByRole("link", { name }).getAttribute("href");
    expect(hrefOf("Hapus filter: Kelas 8")).toBe(
      `/question-bank?elementId=${ELEMENT}&difficulty=sulit&q=luas&sort=oldest`,
    );
    expect(hrefOf("Hapus filter: Geometri")).toContain("grade=8");
    expect(hrefOf("Hapus filter: Geometri")).not.toContain("elementId");
    expect(hrefOf("Hapus filter: Pencarian: luas")).not.toContain("q=");
    expect(hrefOf("Hapus filter: Sulit")).not.toContain("difficulty");
    expect(
      within(group).getByRole("link", { name: "Atur ulang" }).getAttribute("href"),
    ).toBe("/question-bank");
  });

  it("shows the date pills in the viewer's language", () => {
    const query = bankQuerySchema.parse({ from: "2026-11-08", to: "2026-11-09" });
    renderWithIntl(<ActiveFilters query={query} facets={facets} />);
    expect(
      screen.getByRole("link", { name: "Hapus filter: Dari 8 November 2026" }),
    ).toBeTruthy();
    cleanup();
    renderWithIntl(<ActiveFilters query={query} facets={facets} />, { locale: "en" });
    expect(
      screen.getByRole("link", { name: "Remove filter: To November 9, 2026" }),
    ).toBeTruthy();
  });

  it("renders nothing without filters", () => {
    const { container } = renderWithIntl(
      <ActiveFilters query={bankQuerySchema.parse({ sort: "oldest" })} facets={facets} />,
    );
    expect(container.textContent).toBe("");
  });
});
