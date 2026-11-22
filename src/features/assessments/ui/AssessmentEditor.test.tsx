// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  moveItemAction: vi.fn(() => Promise.resolve({ ok: true })),
  removeItemAction: vi.fn(() => Promise.resolve({ ok: true })),
  updateItemToLatestAction: vi.fn(() => Promise.resolve({ ok: true, changed: true })),
  addItemsAction: vi.fn(() => Promise.resolve({ ok: true, added: 2, skipped: 1 })),
  addSectionAction: vi.fn(() => Promise.resolve({ ok: true, id: "x" })),
  renameSectionAction: vi.fn(() => Promise.resolve({ ok: true })),
  removeSectionAction: vi.fn(() => Promise.resolve({ ok: true })),
  updateAssessmentAction: vi.fn(() => Promise.resolve({})),
  createAssessmentAction: vi.fn(() => Promise.resolve({})),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../actions/edit-items", () => ({
  moveItemAction: mocks.moveItemAction,
  removeItemAction: mocks.removeItemAction,
  updateItemToLatestAction: mocks.updateItemToLatestAction,
  addItemsAction: mocks.addItemsAction,
}));
vi.mock("../actions/edit-sections", () => ({
  addSectionAction: mocks.addSectionAction,
  renameSectionAction: mocks.renameSectionAction,
  removeSectionAction: mocks.removeSectionAction,
}));
vi.mock("../actions/update-assessment", () => ({
  updateAssessmentAction: mocks.updateAssessmentAction,
}));
vi.mock("../actions/scoring", () => ({
  setScoringModeAction: vi.fn(),
  setPointsAction: vi.fn(),
  setShuffleAction: vi.fn(),
}));
vi.mock("../actions/approval", () => ({ approveAction: vi.fn(), reopenAction: vi.fn() }));
vi.mock("../actions/create-assessment", () => ({
  createAssessmentAction: mocks.createAssessmentAction,
}));

import { bankQuerySchema } from "@/features/bank";
import type { BankList } from "@/features/bank";
import type { AssessmentEditorView } from "../service/assessments";
import type { EditorItem } from "../service/editor-items";
import { AssessmentEditor } from "./AssessmentEditor";

const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ASSESSMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function item(n: number, sectionId: string, extra: Partial<EditorItem> = {}): EditorItem {
  return {
    itemId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${String(n)}`,
    sectionId,
    questionId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${String(n)}`,
    versionId: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${String(n)}`,
    versionNo: 1,
    points: 0,
    difficulty: "sedang",
    stemMd: `Soal nomor ${String(n)}`,
    options: [],
    correctLabel: "A",
    state: "ok",
    newerVersionAvailable: false,
    canUpdate: false,
    ...extra,
  };
}

function view(status: "draft" | "approved" = "draft"): AssessmentEditorView {
  return {
    assessment: {
      id: ASSESSMENT_ID,
      title: "Ulangan SPLDV",
      kind: "ulangan_harian",
      grade: 8,
      templateId: null,
      examDate: null,
      durationMinutes: 60,
      instructions: null,
      status,
      rowVersion: 3,
      scoringMode: "equal",
      shuffled: false,
    },
    sections: [
      { id: S1, title: "A. Pilihan ganda", items: [item(1, S1), item(2, S1)] },
      {
        id: S2,
        title: "B. Uraian",
        items: [item(3, S2, { newerVersionAvailable: true, canUpdate: true })],
      },
    ],
  };
}

const LIST: BankList = {
  items: [
    {
      questionId: "11111111-1111-4111-8111-111111111111",
      topicTitle: "SPLDV",
      objectiveCode: "TP-3",
      difficulty: "mudah",
      type: "multiple_choice",
      status: "terverifikasi",
      stemExcerptMd: "Hitung dua tambah dua",
      versionNo: 1,
      bankedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      questionId: "22222222-2222-4222-8222-222222222222",
      topicTitle: "SPLDV",
      objectiveCode: null,
      difficulty: "sulit",
      type: "multiple_choice",
      status: "terverifikasi",
      stemExcerptMd: "Hitung tiga tambah tiga",
      versionNo: 1,
      bankedAt: "2026-11-02T00:00:00.000Z",
    },
  ],
  total: 45,
  page: 2,
  pageCount: 3,
  facets: { grades: [8], elements: [], topics: [{ id: "tt", title: "SPLDV" }] },
};

const APPROVAL = {
  problems: [],
  hash: "a".repeat(64),
  approved: false,
  approvedAt: null,
  stale: false,
};

function renderEditor(props: Partial<Parameters<typeof AssessmentEditor>[0]> = {}) {
  return renderWithIntl(
    <AssessmentEditor
      view={view()}
      templates={[]}
      generateHref="/generate?returnTo=%2Fassessment-builder"
      picker={null}
      offered={[]}
      approval={APPROVAL}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("AssessmentEditor outline", () => {
  it("numbers the questions through the sections and shows the totals and the status", () => {
    renderEditor();
    expect(screen.getByRole("listitem", { name: "Soal 1" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Soal 3" })).toBeTruthy();
    // Each section region is named by its own title.
    expect(screen.getByRole("region", { name: "A. Pilihan ganda" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "B. Uraian" })).toBeTruthy();
    expect(screen.getByText("3 soal dalam 2 bagian")).toBeTruthy();
    expect(screen.getByText("Draf")).toBeTruthy();
  });

  it("reorders from the keyboard, announces it and refreshes", async () => {
    renderEditor();
    screen.getByRole("button", { name: "Turunkan soal 1" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(mocks.moveItemAction).toHaveBeenCalledWith({
        itemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
        toSectionId: S1,
        toIndex: 1,
      });
    });
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
    const live = screen
      .getAllByRole("status")
      .find((el) => el.textContent === "Soal 2 dipindahkan.");
    expect(live).toBeTruthy();
  });

  it("shows the reason in an alert when an action is refused", async () => {
    mocks.moveItemAction.mockResolvedValueOnce({
      ok: false,
      reason: "approved",
    } as never);
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Turunkan soal 1" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("sudah disetujui");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("moves a newer-version item to the latest version", async () => {
    renderEditor();
    expect(screen.getAllByText("Ada versi terbaru")).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Pakai versi terbaru soal 3" }),
    );
    await waitFor(() => {
      expect(mocks.updateItemToLatestAction).toHaveBeenCalledWith({
        itemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
      });
    });
  });

  it("adds a section and renames and removes one", async () => {
    renderEditor();
    await userEvent.type(screen.getByLabelText("Judul bagian baru"), "C. Isian");
    await userEvent.click(screen.getByRole("button", { name: "Tambah bagian" }));
    await waitFor(() => {
      expect(mocks.addSectionAction).toHaveBeenCalledWith({
        assessmentId: ASSESSMENT_ID,
        title: "C. Isian",
      });
    });
    const titles = screen.getAllByRole("textbox", { name: "Judul bagian" });
    // The inputs are disabled while the previous action runs.
    await waitFor(() => {
      expect(titles[1].hasAttribute("disabled")).toBe(false);
    });
    await userEvent.clear(titles[1]);
    await userEvent.type(titles[1], "B. Esai");
    await userEvent.click(screen.getAllByRole("button", { name: "Simpan judul" })[1]);
    await waitFor(() => {
      expect(mocks.renameSectionAction).toHaveBeenCalledWith({
        sectionId: S2,
        title: "B. Esai",
      });
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus bagian: B. Uraian" }),
    );
    await waitFor(() => {
      expect(mocks.removeSectionAction).toHaveBeenCalledWith({ sectionId: S2 });
    });
  });

  it("cannot remove the only section", () => {
    const only = view();
    only.sections = [only.sections[0]];
    renderEditor({ view: only });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Hapus bagian/ }).disabled,
    ).toBe(true);
  });

  it("links to /generate with the way back and to the picker of each section", () => {
    renderEditor();
    const link = screen.getByRole("link", { name: "Buat soal baru" });
    expect(link.getAttribute("href")).toBe("/generate?returnTo=%2Fassessment-builder");
    const hrefs = screen
      .getAllByRole("link", { name: "Tambah soal dari Bank Soal" })
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      `/assessment-builder/${ASSESSMENT_ID}?pick=${S1}#picker`,
      `/assessment-builder/${ASSESSMENT_ID}?pick=${S2}#picker`,
    ]);
  });
});

describe("AssessmentEditor when approved", () => {
  it("is read-only: a notice, every control disabled but reopen, and no way to add", () => {
    renderEditor({
      view: view("approved"),
      approval: { ...APPROVAL, approved: true, approvedAt: "2026-11-19T03:00:00.000Z" },
    });
    expect(screen.getByText(/sudah disetujui, sehingga tidak dapat diubah/)).toBeTruthy();
    expect(screen.getByText("Disetujui")).toBeTruthy();
    const reopen = screen.getByRole<HTMLButtonElement>("button", {
      name: "Buka kembali",
    });
    expect(reopen.disabled).toBe(false);
    for (const button of screen.getAllByRole("button")) {
      if (button !== reopen) expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    for (const input of screen.getAllByRole("radio")) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("link", { name: "Buat soal baru" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tambah soal dari Bank Soal" })).toBeNull();
    expect(screen.queryByLabelText("Judul bagian baru")).toBeNull();
  });
});

describe("AssessmentEditor picker", () => {
  const picker = {
    sectionId: S2,
    query: bankQuerySchema.parse({ q: "hitung", page: "2" }),
    list: LIST,
    added: ["22222222-2222-4222-8222-222222222222"],
    pending: [] as string[],
  };

  it("lists the page, marks what is already added and adds only the checked ones to the chosen section", async () => {
    renderEditor({ picker });
    const panel = screen.getByRole("region", { name: "Tambah soal ke B. Uraian" });
    const first = within(panel).getByRole<HTMLInputElement>("checkbox", {
      name: "Pilih soal 1",
    });
    const second = within(panel).getByRole<HTMLInputElement>("checkbox", {
      name: "Pilih soal 2",
    });
    expect(second.checked).toBe(true);
    expect(second.disabled).toBe(true);
    expect(within(panel).getByText(/Sudah ada di asesmen/)).toBeTruthy();
    const add = within(panel).getByRole<HTMLButtonElement>("button", {
      name: "Tambahkan soal",
    });
    expect(add.disabled).toBe(true);

    await userEvent.click(first);
    await userEvent.selectOptions(
      within(panel).getByLabelText("Tambahkan ke bagian"),
      "A. Pilihan ganda",
    );
    await userEvent.click(
      within(panel).getByRole("button", { name: "Tambahkan 1 soal" }),
    );
    await waitFor(() => {
      expect(mocks.addItemsAction).toHaveBeenCalledWith({
        assessmentId: ASSESSMENT_ID,
        sectionId: S1,
        questionIds: ["11111111-1111-4111-8111-111111111111"],
      });
    });
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("status")
          .some(
            (el) => el.textContent === "2 soal ditambahkan, 1 dilewati karena sudah ada.",
          ),
      ).toBe(true);
    });
  });

  it("keeps the bank query in its search, filters and page links", () => {
    renderEditor({ picker });
    const panel = screen.getByRole("region", { name: "Tambah soal ke B. Uraian" });
    const search = within(panel).getByRole<HTMLInputElement>("searchbox");
    expect(search.value).toBe("hitung");
    expect(within(panel).getByRole("search").getAttribute("action")).toBe(
      `/assessment-builder/${ASSESSMENT_ID}`,
    );
    expect(
      within(panel)
        .getByRole("search")
        .querySelector<HTMLInputElement>("input[name=pick]")?.value,
    ).toBe(S2);
    const prev = within(panel)
      .getByRole("link", { name: "Sebelumnya" })
      .getAttribute("href");
    const next = within(panel)
      .getByRole("link", { name: "Berikutnya" })
      .getAttribute("href");
    expect(prev).toContain("q=hitung");
    expect(prev).toContain(`pick=${S2}`);
    expect(prev).not.toContain("page=");
    expect(next).toContain("page=3");
    expect(within(panel).getByText("Halaman 2 dari 3")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Tutup" }).getAttribute("href")).toBe(
      `/assessment-builder/${ASSESSMENT_ID}`,
    );
  });

  it("says so when nothing matches or the bank is empty", () => {
    const { unmount } = renderEditor({
      picker: {
        ...picker,
        list: { ...LIST, items: [], total: 0, page: 1, pageCount: 1 },
      },
    });
    expect(
      screen.getByText("Tidak ada soal yang cocok dengan pencarian ini."),
    ).toBeTruthy();
    unmount();
    renderEditor({
      picker: {
        ...picker,
        list: {
          ...LIST,
          items: [],
          total: 0,
          page: 1,
          pageCount: 1,
          facets: { grades: [], elements: [], topics: [] },
        },
      },
    });
    expect(screen.getByText(/Bank Soal masih kosong/)).toBeTruthy();
  });
});

describe("AssessmentEditor offer after /generate", () => {
  const offered = [
    {
      questionId: "11111111-1111-4111-8111-111111111111",
      stemExcerptMd: "Soal baru satu",
      difficulty: "mudah" as const,
    },
    {
      questionId: "22222222-2222-4222-8222-222222222222",
      stemExcerptMd: "Soal baru dua",
      difficulty: "sedang" as const,
    },
  ];

  it("offers the newly banked questions, all checked, and adds them to the first section", async () => {
    renderEditor({ offered });
    const panel = screen.getByRole("region", { name: "Soal baru di Bank Soal" });
    expect(within(panel).getByText(/2 soal baru tersimpan/)).toBeTruthy();
    for (const box of within(panel).getAllByRole<HTMLInputElement>("checkbox")) {
      expect(box.checked).toBe(true);
    }
    await userEvent.click(
      within(panel).getByRole("button", { name: "Tambahkan 2 soal" }),
    );
    await waitFor(() => {
      expect(mocks.addItemsAction).toHaveBeenCalledWith({
        assessmentId: ASSESSMENT_ID,
        sectionId: S1,
        questionIds: offered.map((o) => o.questionId),
      });
    });
  });

  it("is not shown when empty, nor for an approved assessment", () => {
    renderEditor();
    expect(screen.queryByRole("region", { name: "Soal baru di Bank Soal" })).toBeNull();
    cleanup();
    renderEditor({ offered, view: view("approved") });
    expect(screen.queryByRole("region", { name: "Soal baru di Bank Soal" })).toBeNull();
  });
});

// A harness whose refresh() swaps the view, like router.refresh() re-rendering the server page.
function renderLive(
  next: (current: AssessmentEditorView) => AssessmentEditorView,
  props: Partial<Parameters<typeof AssessmentEditor>[0]> = {},
) {
  let swap: (() => void) | null = null;
  function Harness() {
    const [current, setCurrent] = useState(view());
    swap = () => {
      setCurrent((old) => next(old));
    };
    return (
      <AssessmentEditor
        view={current}
        templates={[]}
        generateHref="/generate"
        picker={null}
        offered={[]}
        approval={APPROVAL}
        {...props}
      />
    );
  }
  mocks.refresh.mockImplementation(() => {
    act(() => {
      swap?.();
    });
  });
  return renderWithIntl(<Harness />);
}

const ID1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const ID2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";

describe("AssessmentEditor keeps the keyboard where it was", () => {
  it("after a move that disables the pressed button, focus goes to the item's other arrow", async () => {
    renderLive((old) => {
      const [first, second] = old.sections[0].items;
      return {
        ...old,
        sections: [{ ...old.sections[0], items: [second, first] }, old.sections[1]],
      };
    });
    screen.getByRole("button", { name: "Turunkan soal 1" }).focus();
    await userEvent.keyboard("{Enter}");
    // Question 1 is now second and last: its down arrow is disabled, so its up arrow takes focus.
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(`item-${ID1}-up`);
    });
  });

  it("after removing an item, focus goes to its section's title", async () => {
    renderLive((old) => ({
      ...old,
      sections: [
        {
          ...old.sections[0],
          items: old.sections[0].items.filter((i) => i.itemId !== ID2),
        },
        old.sections[1],
      ],
    }));
    await userEvent.click(screen.getByRole("button", { name: "Keluarkan soal 2" }));
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(`section-${S1}-title`);
    });
  });

  it("after adding a section, focus goes to the new section's title", async () => {
    mocks.addSectionAction.mockResolvedValueOnce({ ok: true, id: "new-section" });
    renderLive((old) => ({
      ...old,
      sections: [...old.sections, { id: "new-section", title: "C. Isian", items: [] }],
    }));
    await userEvent.type(screen.getByLabelText("Judul bagian baru"), "C. Isian");
    await userEvent.click(screen.getByRole("button", { name: "Tambah bagian" }));
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("section-new-section-title");
    });
  });

  it("after removing a section, focus goes to the outline heading", async () => {
    renderLive((old) => ({ ...old, sections: [old.sections[0]] }));
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus bagian: B. Uraian" }),
    );
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("editor-outline");
    });
  });
});

describe("AssessmentEditor keeps what was typed when an add is refused", () => {
  it("keeps the new section's title", async () => {
    mocks.addSectionAction.mockResolvedValueOnce({
      ok: false,
      reason: "tooMany",
    } as never);
    renderEditor();
    await userEvent.type(screen.getByLabelText("Judul bagian baru"), "C. Isian");
    await userEvent.click(screen.getByRole("button", { name: "Tambah bagian" }));
    expect((await screen.findByRole("alert")).textContent).toContain("batas");
    expect(screen.getByLabelText<HTMLInputElement>("Judul bagian baru").value).toBe(
      "C. Isian",
    );
  });

  it("keeps the checked questions and names the refused one", async () => {
    mocks.addItemsAction.mockResolvedValueOnce({
      ok: false,
      reason: "pendingCheck",
      questionId: "11111111-1111-4111-8111-111111111111",
    } as never);
    renderEditor({
      picker: {
        sectionId: S2,
        query: bankQuerySchema.parse({}),
        list: LIST,
        added: [],
        pending: [],
      },
    });
    const panel = screen.getByRole("region", { name: "Tambah soal ke B. Uraian" });
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Pilih soal 1" }));
    await userEvent.click(
      within(panel).getByRole("button", { name: "Tambahkan 1 soal" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Versi baru soal 1 masih menunggu pemeriksaan, jadi tidak ada yang ditambahkan.",
    );
    expect(
      within(panel).getByRole<HTMLInputElement>("checkbox", { name: "Pilih soal 1" })
        .checked,
    ).toBe(true);
  });

  it("shows a question with a pending new version disabled, with its own reason", () => {
    renderEditor({
      picker: {
        sectionId: S2,
        query: bankQuerySchema.parse({}),
        list: LIST,
        added: [],
        pending: ["22222222-2222-4222-8222-222222222222"],
      },
    });
    const panel = screen.getByRole("region", { name: "Tambah soal ke B. Uraian" });
    const second = within(panel).getByRole<HTMLInputElement>("checkbox", {
      name: "Pilih soal 2",
    });
    expect(second.disabled).toBe(true);
    expect(within(panel).getByText(/Versi baru menunggu pemeriksaan/)).toBeTruthy();
    expect(
      within(panel).getByRole<HTMLInputElement>("checkbox", { name: "Pilih soal 1" })
        .disabled,
    ).toBe(false);
  });
});
