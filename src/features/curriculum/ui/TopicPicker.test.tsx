// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type {
  CurriculumVersion,
  TopicWithObjectives,
} from "@/features/curriculum/service/repository";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { FormProvider, useForm, useWatch } from "react-hook-form";
import { TopicErrorContext } from "@/features/generation/ui/topic-error-context";
import { TopicPicker } from "./TopicPicker";

const version: CurriculumVersion = {
  id: "v",
  code: "kurikulum-merdeka-fase-d-2025",
  title: "Kurikulum Merdeka",
  sourceTitle: "Keputusan BSKAP 046/H/KR/2025",
  sourceUrl: "https://guru.example.test/cp",
  decreeRef: null,
  publishedOn: "2025-07-16",
  retrievedOn: "2026-09-23",
};

const topic = (
  over: Partial<TopicWithObjectives> & { stableKey: string },
): TopicWithObjectives => ({
  id: over.stableKey,
  grade: 8,
  title: "Judul",
  scopeNotes: "Catatan",
  sortOrder: 1,
  sourceRef: "ref",
  element: { code: "bilangan", name: "Bilangan" },
  objectives: [],
  ...over,
});

const topics: TopicWithObjectives[] = [
  topic({
    stableKey: "pangkat",
    title: "Bilangan Berpangkat",
    scopeNotes: "Eksponen dan akar",
    element: { code: "bilangan", name: "Bilangan" },
    objectives: [
      { id: "o1", code: "TP-1", text: "Menyederhanakan bentuk akar", sourceRef: "r" },
      { id: "o2", code: "TP-2", text: "Menggunakan notasi ilmiah", sourceRef: "r" },
    ],
  }),
  topic({
    stableKey: "spldv",
    title: "SPLDV",
    scopeNotes: "Substitusi dan eliminasi",
    element: { code: "aljabar", name: "Aljabar" },
    objectives: [{ id: "o3", code: "TP-3", text: "Menyelesaikan SPLDV", sourceRef: "r" }],
  }),
  topic({
    stableKey: "garis",
    title: "Persamaan Garis Lurus",
    scopeNotes: "Gradien",
    element: { code: "aljabar", name: "Aljabar" },
    objectives: [],
  }),
];

beforeEach(() => {
  replace.mockClear();
});
afterEach(cleanup);

const renderPicker = (selectedKey: string | null = null) =>
  renderWithIntl(
    <TopicPicker topics={topics} version={version} selectedKey={selectedKey} />,
  );

describe("TopicPicker", () => {
  it("groups the topics under their CP element headings", () => {
    renderPicker();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Bilangan", "Aljabar"]));
    const aljabar = screen.getByRole("heading", {
      name: "Aljabar",
      level: 3,
    }).parentElement;
    expect(within(aljabar!).getAllByRole("radio")).toHaveLength(2);
  });

  it("shows each topic's title, scope notes and a TP disclosure with the count", () => {
    renderPicker();
    const radio = screen.getByRole("radio", { name: /Bilangan Berpangkat/ });
    expect(radio).toBeTruthy();
    expect(screen.getByText("Eksponen dan akar")).toBeTruthy();
    expect(screen.getByText("Tujuan pembelajaran (2)")).toBeTruthy();
    expect(screen.getByText("Menyederhanakan bentuk akar")).toBeTruthy();
    // The TP chip on the card, and the code beside its text in the disclosure.
    expect(screen.getAllByText("TP-1")).toHaveLength(2);
    expect(
      screen.getByText("Belum ada tujuan pembelajaran untuk topik ini."),
    ).toBeTruthy();
  });

  it("keeps the TP disclosure outside the radio's label", () => {
    renderPicker();
    const radio = screen.getByRole("radio", { name: /Bilangan Berpangkat/ });
    const label = document.querySelector(`label[for="${radio.id}"]`)!;
    expect(label.querySelector("details")).toBeNull();
    expect(label.closest("details")).toBeNull();
  });

  it("narrows the list as the teacher types and announces the count", async () => {
    renderPicker();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Cari topik" }),
      "eliminasi",
    );
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("1 topik ditemukan");
  });

  it("shows an empty state with a clear button when nothing matches", async () => {
    renderPicker();
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Tidak ada topik yang cocok",
    );
    await userEvent.click(screen.getByRole("button", { name: "Hapus pencarian" }));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("selecting a topic updates the URL without scrolling and shows a summary", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("radio", { name: /SPLDV/ }));
    expect(replace).toHaveBeenCalledWith("/generate?grade=8&topic=spldv", {
      scroll: false,
    });
    const summary = screen.getByRole("region", { name: "Topik dipilih" });
    expect(within(summary).getByText("SPLDV")).toBeTruthy();
    expect(within(summary).getByText("Menyelesaikan SPLDV")).toBeTruthy();
    expect(within(summary).getByText("TP-3")).toBeTruthy();
    expect(within(summary).getByRole("heading", { level: 3 }).textContent).toBe(
      "Topik dipilih",
    );
    expect(within(summary).getByRole("heading", { level: 4 }).textContent).toBe("SPLDV");
  });

  it("shows the optimistic selection immediately even before the URL prop catches up", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("radio", { name: /Persamaan Garis Lurus/ }));
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /Persamaan Garis Lurus/ })
        .checked,
    ).toBe(true);
    expect(
      within(screen.getByRole("region", { name: "Topik dipilih" })).getByText(
        "Persamaan Garis Lurus",
      ),
    ).toBeTruthy();
  });

  it("follows the URL when the selectedKey prop changes while mounted", () => {
    const { rerender } = renderPicker("pangkat");
    rerender(<TopicPicker topics={topics} version={version} selectedKey="garis" />);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /Persamaan Garis Lurus/ })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /Bilangan Berpangkat/ })
        .checked,
    ).toBe(false);
    rerender(<TopicPicker topics={topics} version={version} selectedKey={null} />);
    expect(screen.getByText("Belum ada topik dipilih.")).toBeTruthy();
  });

  it("returns focus to the first topic radio after clearing the selection", async () => {
    renderPicker("spldv");
    await userEvent.click(screen.getByRole("button", { name: "Hapus pilihan" }));
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
  });

  it("falls back to the search box when clearing the selection with no visible topics", async () => {
    renderPicker("spldv");
    const search = screen.getByRole("searchbox");
    await userEvent.type(search, "zzz");
    await userEvent.click(screen.getByRole("button", { name: "Hapus pilihan" }));
    expect(document.activeElement).toBe(search);
  });

  it("returns focus to the search box after clearing the search", async () => {
    renderPicker();
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    await userEvent.click(screen.getByRole("button", { name: "Hapus pencarian" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("preselects the topic given by the URL", () => {
    renderPicker("garis");
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /Persamaan Garis Lurus/ })
        .checked,
    ).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it("clears the selection and the topic parameter", async () => {
    renderPicker("spldv");
    await userEvent.click(screen.getByRole("button", { name: "Hapus pilihan" }));
    expect(replace).toHaveBeenCalledWith("/generate?grade=8", { scroll: false });
    expect(screen.getByText("Belum ada topik dipilih.")).toBeTruthy();
  });

  it("ArrowDown moves the selection across element groups (one radio group)", async () => {
    renderPicker("pangkat");
    screen.getByRole("radio", { name: /Bilangan Berpangkat/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/generate?grade=8&topic=spldv", {
      scroll: false,
    });
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /SPLDV/ }).checked).toBe(
      true,
    );
  });

  it("Tab from the search box reaches the first topic radio when nothing is selected", async () => {
    renderPicker();
    screen.getByRole("searchbox").focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
  });

  it("Tab from the search box reaches the checked radio when a topic is preselected", async () => {
    renderPicker("garis");
    screen.getByRole("searchbox").focus();
    // Unchecked radios leave the tab order, but each topic's <summary> is still a tab stop.
    for (let i = 0; i < 10; i++) {
      await userEvent.tab();
      if ((document.activeElement as HTMLInputElement).type === "radio") break;
    }
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: /Persamaan Garis Lurus/ }),
    );
  });

  it("links the source safely in a new tab", () => {
    renderPicker();
    const link = screen.getByRole<HTMLAnchorElement>("link", { name: /Buka sumber/ });
    expect(link.href).toBe("https://guru.example.test/cp");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(screen.getByText(/Keputusan BSKAP 046\/H\/KR\/2025/)).toBeTruthy();
  });

  it("has no axe violations (colour contrast excluded: jsdom cannot compute it)", async () => {
    const { container } = renderPicker("spldv");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("still posts the selected topic after the search filter hides it", async () => {
    let posted: FormData | null = null;
    renderWithIntl(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          posted = new FormData(event.currentTarget);
        }}
      >
        <TopicPicker topics={topics} version={version} selectedKey={null} />
        <button type="submit">Kirim</button>
      </form>,
    );
    await userEvent.click(screen.getByRole("radio", { name: /SPLDV/ }));
    await userEvent.type(screen.getByRole("searchbox"), "pangkat");
    expect(screen.queryByRole("radio", { name: /SPLDV/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Kirim" }));
    expect((posted as FormData | null)?.getAll("topic")).toEqual(["spldv"]);
  });

  it("posts no topic when nothing is selected", async () => {
    let posted: FormData | null = null;
    renderWithIntl(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          posted = new FormData(event.currentTarget);
        }}
      >
        <TopicPicker topics={topics} version={version} selectedKey={null} />
        <button type="submit">Kirim</button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Kirim" }));
    expect((posted as FormData | null)?.getAll("topic")).toEqual([""]);
  });

  it("describes the topic list by the error element when the form provides one", () => {
    renderWithIntl(
      <TopicErrorContext.Provider value="error-topic">
        <TopicPicker topics={topics} version={version} selectedKey={null} />
      </TopicErrorContext.Provider>,
    );
    const list = screen.getByRole("group", { name: "Pilih topik" });
    expect(list.getAttribute("aria-describedby")).toBe("error-topic");
  });

  it("has no description without an error", () => {
    renderPicker();
    const list = screen.getByRole("group", { name: "Pilih topik" });
    expect(list.hasAttribute("aria-describedby")).toBe(false);
  });

  it("does not submit an enclosing form when Enter is pressed in the search box", async () => {
    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });
    renderWithIntl(
      <form onSubmit={onSubmit as never}>
        <TopicPicker topics={topics} version={version} selectedKey={null} />
        <button type="submit">Kirim</button>
      </form>,
    );
    const box = screen.getByRole("searchbox", { name: "Cari topik" });
    await userEvent.type(box, "spldv{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("marks the selected topic card with a visible selected style and checked state", () => {
    renderPicker("spldv");
    const radio = screen.getByRole<HTMLInputElement>("radio", { name: /SPLDV/ });
    expect(radio.checked).toBe(true);
    expect(radio.closest("li")!.className).toContain("ring-2");
    const other = screen.getByRole("radio", { name: /Bilangan Berpangkat/ });
    expect(other.closest("li")!.className).not.toContain("ring-2");
  });

  it("shows the TP chips on the topic card", () => {
    renderPicker();
    const card = screen
      .getByRole("radio", { name: /Bilangan Berpangkat/ })
      .closest("li")!;
    const chips = within(card).getAllByText(/^TP-\d$/);
    expect(chips.some((c) => c.className.includes("rounded-full"))).toBe(true);
  });

  describe("inside a React Hook Form provider", () => {
    function Harness({ selectedKey }: { selectedKey: string | null }) {
      const form = useForm<{ topic: string }>({
        defaultValues: { topic: selectedKey ?? "" },
      });
      const topic = useWatch({ control: form.control, name: "topic" });
      return (
        <FormProvider {...form}>
          <TopicPicker topics={topics} version={version} selectedKey={selectedKey} />
          <output data-testid="value">{topic}</output>
        </FormProvider>
      );
    }

    it("sets the form's topic on a choice, on clearing it and when the URL changes", async () => {
      const { rerender } = renderWithIntl(<Harness selectedKey={null} />);
      const value = () => screen.getByTestId("value").textContent;
      await userEvent.click(screen.getByRole("radio", { name: /SPLDV/ }));
      expect(value()).toBe("spldv");
      await userEvent.click(screen.getByRole("button", { name: "Hapus pilihan" }));
      expect(value()).toBe("");
      rerender(<Harness selectedKey="garis" />);
      expect(value()).toBe("garis");
    });
  });
});
