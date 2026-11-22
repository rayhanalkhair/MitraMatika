// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
  deleteForever: vi.fn(),
  refresh: vi.fn(),
  restoreAssessment: vi.fn(),
  deleteAssessment: vi.fn(),
  restoreTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  restoreMaterial: vi.fn(),
  deleteMaterial: vi.fn(),
  restoreFolder: vi.fn(),
  deleteFolder: vi.fn(),
  restoreSolverSession: vi.fn(),
  deleteSolverSession: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../actions/restore", () => ({ restoreQuestionAction: mocks.restore }));
vi.mock("../actions/delete-permanently", () => ({
  deletePermanentlyAction: mocks.deleteForever,
}));
vi.mock("../actions/assessment", () => ({
  restoreAssessmentAction: mocks.restoreAssessment,
  deleteAssessmentAction: mocks.deleteAssessment,
}));
vi.mock("../actions/material", () => ({
  restoreMaterialAction: mocks.restoreMaterial,
  deleteMaterialAction: mocks.deleteMaterial,
  restoreFolderAction: mocks.restoreFolder,
  deleteFolderAction: mocks.deleteFolder,
}));
vi.mock("../actions/solver", () => ({
  restoreSolverSessionAction: mocks.restoreSolverSession,
  deleteSolverSessionAction: mocks.deleteSolverSession,
}));
vi.mock("../actions/template", () => ({
  restoreTemplateAction: mocks.restoreTemplate,
  deleteTemplateAction: mocks.deleteTemplate,
}));

import type { TrashedAssessment } from "../service/assessment-trash";
import type { TrashedFolder, TrashedMaterial } from "../service/material-trash";
import type { TrashedSolverSession } from "../service/solver-trash";
import type { TrashedTemplate } from "../service/template-trash";
import type { TrashItem } from "../service/trash";
import { TrashList } from "./TrashList";

const ITEMS: TrashItem[] = [
  {
    questionId: "11111111-1111-4111-8111-111111111111",
    topicTitle: "Bilangan Bulat",
    stemExcerptMd: "Hitung $2+2$.",
    versionCount: 3,
    deletedAt: "2026-11-08T10:00:00.000Z",
    purgeAfter: "2026-12-08T10:00:00.000Z",
    daysLeft: 12,
    pinnedBy: [],
  },
  {
    questionId: "22222222-2222-4222-8222-222222222222",
    topicTitle: "Pecahan",
    stemExcerptMd: "Sederhanakan.",
    versionCount: 1,
    deletedAt: "2026-11-01T10:00:00.000Z",
    purgeAfter: "2026-12-01T10:00:00.000Z",
    daysLeft: 0,
    pinnedBy: [],
  },
];

const ASSESSMENTS: TrashedAssessment[] = [
  {
    assessmentId: "33333333-3333-4333-8333-333333333333",
    title: "Ulangan Bab 1",
    approved: true,
    sectionCount: 2,
    itemCount: 10,
    exportCount: 7,
    usageCount: 10,
    deletedAt: "2026-11-08T10:00:00.000Z",
    purgeAfter: "2026-12-08T10:00:00.000Z",
    daysLeft: 18,
  },
];

const TEMPLATES: TrashedTemplate[] = [
  {
    templateId: "44444444-4444-4444-8444-444444444444",
    name: "Kop sekolah",
    schoolName: "SMP Negeri 1 Contoh",
    hasLogo: true,
    usedBy: ["Ulangan Bab 1", "STS"],
    deletedAt: "2026-11-09T10:00:00.000Z",
    purgeAfter: "2026-12-09T10:00:00.000Z",
    daysLeft: 19,
  },
];

// jsdom has <dialog> but not its modal methods: open and close it the way a browser does.
beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.restore.mockResolvedValue({ ok: true });
  mocks.deleteForever.mockResolvedValue({ ok: true });
  for (const action of [
    mocks.restoreAssessment,
    mocks.deleteAssessment,
    mocks.restoreTemplate,
    mocks.deleteTemplate,
  ]) {
    action.mockResolvedValue({ ok: true });
  }
});
afterEach(cleanup);

describe("TrashList", () => {
  it("trash page lists items with days left and the confirmation lists what is deleted", async () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    const list = screen.getByRole("list", { name: "Soal di Sampah" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Bilangan Bulat");
    expect(rows[0].textContent).toContain("12 hari lagi sebelum dihapus untuk selamanya");
    expect(rows[0].textContent).toContain("Dihapus 8 November 2026");
    // Due but not yet purged: it goes at the next daily cleanup, which may be tomorrow.
    expect(rows[1].textContent).toContain("Dihapus pada pembersihan berikutnya");

    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Bilangan Bulat" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Hapus soal ini untuk selamanya?",
    });
    const what = within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(what).toEqual([
      "Soal ini",
      "Semua 3 versi soal",
      "Semua hasil verifikasi setiap versi",
    ]);
    // Cancel is the safe default.
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Batal" }),
    );
    expect(mocks.deleteForever).not.toHaveBeenCalled();
  });

  it("deletes for good only after the confirmation and announces it", async () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" }),
    );
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(mocks.deleteForever).toHaveBeenCalledWith({ questionId: ITEMS[1].questionId });
    expect(screen.queryByRole("dialog")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Soal dihapus untuk selamanya.");
    expect(document.activeElement).toBe(status);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("moves focus to the announcement only once the modal dialog is gone", async () => {
    // A browser ignores focus() on anything outside an open modal dialog (it is inert), so the
    // move must happen after the dialog has left the document. jsdom has no inertness: record
    // whether a dialog was still present at the moment of the focus call instead.
    const dialogPresentAtFocus: boolean[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute("role") === "status") {
        dialogPresentAtFocus.push(document.querySelector("dialog") !== null);
      }
    });
    try {
      renderWithIntl(<TrashList items={ITEMS} />);
      await userEvent.click(
        screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" }),
      );
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Hapus selamanya",
        }),
      );
    } finally {
      focus.mockRestore();
    }
    expect(dialogPresentAtFocus).toEqual([false]);
  });

  it("names a single version in the singular", async () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" }),
    );
    expect(
      within(screen.getByRole("dialog"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toContain("Satu-satunya versi soal");
  });

  it("cancel closes the confirmation, deletes nothing and returns focus to the button", async () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    const opener = screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.deleteForever).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("shows a refused deletion inside the confirmation", async () => {
    mocks.deleteForever.mockResolvedValue({ ok: false, reason: "not_in_trash" });
    renderWithIntl(<TrashList items={ITEMS} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(
      "Soal ini sudah tidak ada di Sampah. Muat ulang halaman.",
    );
  });

  it("restores a question and announces it", async () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan soal: Bilangan Bulat" }),
    );
    expect(mocks.restore).toHaveBeenCalledWith({ questionId: ITEMS[0].questionId });
    expect(screen.getByRole("status").textContent).toBe(
      "Soal dipulihkan ke tempat asalnya.",
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows a refused restore as an alert", async () => {
    mocks.restore.mockResolvedValue({ ok: false, reason: "signed_out" });
    renderWithIntl(<TrashList items={ITEMS} />);
    await userEvent.click(screen.getByRole("button", { name: "Pulihkan soal: Pecahan" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Sesi Anda berakhir. Masuk lagi, lalu coba lagi.",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("buttons are at least 44 px tall and the empty trash says so", () => {
    renderWithIntl(<TrashList items={ITEMS} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
    }
    cleanup();
    renderWithIntl(<TrashList items={[]} />);
    expect(screen.getByText("Sampah kosong")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("TrashList with assessments and templates", () => {
  const renderAll = () =>
    renderWithIntl(
      <TrashList items={ITEMS} assessments={ASSESSMENTS} templates={TEMPLATES} />,
    );

  it("lists each kind under its own heading with the days left", () => {
    renderAll();
    for (const heading of ["Soal", "Asesmen", "Templat dokumen"]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeTruthy();
    }
    const assessments = screen.getByRole("list", { name: "Asesmen di Sampah" });
    const [assessment] = within(assessments).getAllByRole("listitem");
    expect(assessment.textContent).toContain("Ulangan Bab 1");
    expect(assessment.textContent).toContain("Sudah disetujui");
    expect(assessment.textContent).toContain("10 soal · 2 bagian");
    expect(assessment.textContent).toContain(
      "18 hari lagi sebelum dihapus untuk selamanya",
    );
    const templates = screen.getByRole("list", { name: "Templat di Sampah" });
    const [template] = within(templates).getAllByRole("listitem");
    expect(template.textContent).toContain("Kop sekolah");
    expect(template.textContent).toContain("SMP Negeri 1 Contoh");
    expect(template.textContent).toContain(
      "Masih dipakai oleh asesmen “Ulangan Bab 1” dan “STS”",
    );
    expect(template.textContent).toContain(
      "19 hari lagi sebelum dihapus untuk selamanya",
    );
  });

  it("the assessment's confirmation lists what goes, and its questions stay", async () => {
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya asesmen: Ulangan Bab 1" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Hapus asesmen ini untuk selamanya?",
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Asesmen ini",
      "2 bagian dan 10 butir soal di dalamnya",
      "7 berkas ekspor yang tersimpan",
      "10 catatan pemakaian soal",
    ]);
    expect(dialog.textContent).toContain("Soal-soalnya tetap ada di Bank Soal.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(mocks.deleteAssessment).toHaveBeenCalledWith({
      id: ASSESSMENTS[0].assessmentId,
    });
    expect(mocks.deleteForever).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "Asesmen dihapus untuk selamanya.",
    );
  });

  it("the template's confirmation lists the template and its logo", async () => {
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya templat: Kop sekolah" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Hapus templat ini untuk selamanya?",
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Templat ini", "Logo sekolahnya"]);
  });

  it("shows a template still in use as a refusal naming the assessments", async () => {
    mocks.deleteTemplate.mockResolvedValue({
      ok: false,
      reason: "in_use",
      assessments: ["Ulangan Bab 1", "STS"],
    });
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya templat: Kop sekolah" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(mocks.deleteTemplate).toHaveBeenCalledWith({ id: TEMPLATES[0].templateId });
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(
      "Belum bisa dihapus untuk selamanya: templat ini masih dipakai oleh asesmen “Ulangan Bab 1” dan “STS”. Pilih templat lain di asesmen itu, atau hapus asesmen itu untuk selamanya dulu.",
    );
  });

  it("shows a pinned question as a refusal naming the assessments", async () => {
    mocks.deleteForever.mockResolvedValue({
      ok: false,
      reason: "in_use",
      assessments: ["Ulangan Bab 1"],
    });
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Pecahan" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(
      "Belum bisa dihapus untuk selamanya: soal ini masih dipakai di asesmen “Ulangan Bab 1”. Keluarkan soal itu dari asesmennya, atau hapus asesmen itu untuk selamanya dulu.",
    );
  });

  it("restores an assessment and a template and announces each", async () => {
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan asesmen: Ulangan Bab 1" }),
    );
    expect(mocks.restoreAssessment).toHaveBeenCalledWith({
      id: ASSESSMENTS[0].assessmentId,
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Asesmen dipulihkan ke tempat asalnya, dengan persetujuannya.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan templat: Kop sekolah" }),
    );
    expect(mocks.restoreTemplate).toHaveBeenCalledWith({ id: TEMPLATES[0].templateId });
    expect(screen.getByRole("status").textContent).toBe(
      "Templat dipulihkan ke tempat asalnya.",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("names a gone assessment in a refused restore", async () => {
    mocks.restoreAssessment.mockResolvedValue({ ok: false, reason: "not_in_trash" });
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan asesmen: Ulangan Bab 1" }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Asesmen ini sudah tidak ada di sini. Muat ulang halaman.",
    );
  });

  it("is empty only when nothing of any kind is in the trash, and keeps 44 px buttons", () => {
    renderWithIntl(<TrashList items={[]} assessments={[]} templates={TEMPLATES} />);
    expect(screen.queryByText("Sampah kosong")).toBeNull();
    expect(screen.queryByRole("list", { name: "Soal di Sampah" })).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
    }
  });
});

describe("TrashList, the details of a row", () => {
  it("says a pinned question is kept while its assessments use it, instead of a purge date", () => {
    renderWithIntl(
      <TrashList items={[{ ...ITEMS[1], pinnedBy: ["Ulangan Bab 1", "STS"] }]} />,
    );
    const [row] = within(
      screen.getByRole("list", { name: "Soal di Sampah" }),
    ).getAllByRole("listitem");
    expect(row.textContent).toContain(
      "Disimpan selama masih dipakai di asesmen \u201cUlangan Bab 1\u201d dan \u201cSTS\u201d",
    );
    expect(row.textContent).not.toContain("Dihapus pada pembersihan berikutnya");
  });

  it("says when a restored template came back as a plain one and its approvals need renewing", async () => {
    mocks.restoreTemplate.mockResolvedValue({ ok: true, defaultDropped: true });
    renderWithIntl(<TrashList items={[]} templates={TEMPLATES} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan templat: Kop sekolah" }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Templat dipulihkan sebagai templat biasa karena templat lain sudah menjadi templat default.",
    );
  });
});

describe("TrashList with learning materials and folders", () => {
  const MATERIALS: TrashedMaterial[] = [
    {
      materialId: "55555555-5555-4555-8555-555555555555",
      title: "Buku Siswa Kelas 8",
      kind: "pdf",
      pageCount: 184,
      sectionCount: 5,
      citationCount: 2,
      deletedAt: "2026-11-10T10:00:00.000Z",
      purgeAfter: "2026-12-10T10:00:00.000Z",
      daysLeft: 20,
    },
  ];
  const FOLDERS: TrashedFolder[] = [
    {
      folderId: "66666666-6666-4666-8666-666666666666",
      name: "Semester 1",
      deletedAt: "2026-11-10T10:00:00.000Z",
      purgeAfter: "2026-12-10T10:00:00.000Z",
      daysLeft: 20,
    },
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteMaterial.mockResolvedValue({ ok: true });
    mocks.restoreFolder.mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);
  const renderAll = () =>
    renderWithIntl(<TrashList items={[]} materials={MATERIALS} folders={FOLDERS} />);

  it("lists materials and folders under their own headings", () => {
    renderAll();
    for (const heading of ["Materi pembelajaran", "Folder materi"]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeTruthy();
    }
    const [material] = within(
      screen.getByRole("list", { name: "Materi di Sampah" }),
    ).getAllByRole("listitem");
    expect(material.textContent).toContain("Buku Siswa Kelas 8");
    expect(material.textContent).toContain(
      "20 hari lagi sebelum dihapus untuk selamanya",
    );
    expect(
      within(screen.getByRole("list", { name: "Folder di Sampah" })).getByText(
        "Semester 1",
      ),
    ).toBeTruthy();
  });

  it("the material's confirmation lists the file, page images, text and chapters, and that banked questions stay", async () => {
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya materi: Buku Siswa Kelas 8" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Hapus materi ini untuk selamanya?",
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Berkas aslinya", "Gambar halamannya", "Teks semua halamannya", "5 bab"]);
    expect(dialog.textContent).toContain("Materi sumber telah dihapus");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(mocks.deleteMaterial).toHaveBeenCalledWith({ id: MATERIALS[0].materialId });
    expect(screen.getByRole("status").textContent).toBe(
      "Materi dihapus untuk selamanya.",
    );
  });

  it("restores a folder and names a gone material in a refused restore", async () => {
    renderAll();
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan folder: Semester 1" }),
    );
    expect(mocks.restoreFolder).toHaveBeenCalledWith({ id: FOLDERS[0].folderId });
    expect(screen.getByRole("status").textContent).toBe("Folder dipulihkan.");
    mocks.restoreMaterial.mockResolvedValue({ ok: false, reason: "not_in_trash" });
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan materi: Buku Siswa Kelas 8" }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Materi ini sudah tidak ada di sini. Muat ulang halaman.",
    );
  });
});

describe("TrashList with solver sessions", () => {
  const SESSIONS: TrashedSolverSession[] = [
    {
      sessionId: "77777777-7777-4777-8777-777777777777",
      excerptMd: "Hitung $x + 2 = 5$",
      solutionCount: 2,
      hasPhoto: true,
      deletedAt: "2026-11-10T10:00:00.000Z",
      purgeAfter: "2026-12-10T10:00:00.000Z",
      daysLeft: 20,
    },
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteSolverSession.mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it("lists them under their own heading and confirms what a delete takes", async () => {
    renderWithIntl(<TrashList items={[]} solverSessions={SESSIONS} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Soal yang diselesaikan" }),
    ).toBeTruthy();
    const [row] = within(
      screen.getByRole("list", { name: "Soal yang diselesaikan di Sampah" }),
    ).getAllByRole("listitem");
    expect(row.textContent).toContain("20 hari lagi sebelum dihapus untuk selamanya");
    await userEvent.click(
      screen.getByRole("button", { name: "Hapus selamanya soal: Hitung x + 2 = 5" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Hapus soal ini untuk selamanya?",
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Teks soalnya", "2 penyelesaian", "Foto soalnya"]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Hapus selamanya" }),
    );
    expect(mocks.deleteSolverSession).toHaveBeenCalledWith({ id: SESSIONS[0].sessionId });
    expect(screen.getByRole("status").textContent).toBe("Soal dihapus untuk selamanya.");
  });

  it("names a gone session in a refused restore", async () => {
    mocks.restoreSolverSession.mockResolvedValue({ ok: false, reason: "not_found" });
    renderWithIntl(<TrashList items={[]} solverSessions={SESSIONS} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Pulihkan soal: Hitung x + 2 = 5" }),
    );
    expect(mocks.restoreSolverSession).toHaveBeenCalledWith({
      id: SESSIONS[0].sessionId,
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Soal ini sudah tidak ada di Sampah. Muat ulang halaman.",
    );
  });
});
