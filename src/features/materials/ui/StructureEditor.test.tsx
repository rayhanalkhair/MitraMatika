// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  requestStructure: vi.fn(),
  confirmStructure: vi.fn(),
  jobStatus: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../actions/structure", () => ({
  requestStructureAction: mocks.requestStructure,
  confirmStructureAction: mocks.confirmStructure,
}));
vi.mock("@/lib/jobs/client/use-job-status", () => ({ useJobStatus: mocks.jobStatus }));

import { structureFormSchema } from "../schema/structure";
import { StructureEditor } from "./StructureEditor";

const ID = "11111111-1111-4111-8111-111111111111";
const TOPIC = "99999999-9999-4999-8999-999999999999";
const INVALID =
  "Periksa isian: judul wajib diisi, tahun ajaran seperti 2026/2027, dan setiap bab berakhir di atau setelah halaman awalnya.";
const PROPOSAL_NOTE = "Diusulkan AI: periksa setiap bab sebelum menyimpan.";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobStatus.mockReturnValue({ data: undefined });
});
afterEach(cleanup);

interface SavedSection {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number | null;
  topicId: string | null;
}
const base = {
  materialId: ID,
  status: "ready",
  pageCount: 60,
  saved: {
    title: "buku-siswa",
    grade: null,
    academicYear: null,
    metadataConfirmedAt: null as string | null,
    sections: [] as SavedSection[],
  },
  topics: [{ id: TOPIC, title: "SPLDV", grade: 8 }],
  job: null,
};
const proposal = {
  title: "Matematika Kelas VIII",
  grade: 8 as const,
  chapters: [
    { title: "Pola Bilangan", pageStart: 3, pageEnd: 44, topicId: null },
    { title: "SPLDV", pageStart: 45, pageEnd: 60, topicId: TOPIC },
  ],
  proposedAt: "2026-11-20T02:00:00.000Z",
};
const save = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Simpan struktur" });
const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const lastValues = () =>
  (mocks.confirmStructure.mock.calls[0] as [{ values: unknown }])[0].values;

describe("StructureEditor", () => {
  it("fills editable fields from the AI proposal, marked as the AI's, and saves what the teacher edits", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: true });
    renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
    expect(screen.getByText(PROPOSAL_NOTE)).toBeTruthy();
    expect(input("Judul").value).toBe("Matematika Kelas VIII");
    expect(screen.getByLabelText<HTMLSelectElement>("Kelas").value).toBe("8");
    expect(input("Judul bab 2").value).toBe("SPLDV");
    expect(screen.getByLabelText<HTMLSelectElement>("Topik kurikulum bab 2").value).toBe(
      TOPIC,
    );
    await userEvent.type(input("Tahun ajaran"), "2026/2027");
    await userEvent.click(save());
    await waitFor(() => {
      expect(mocks.confirmStructure).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("status").textContent).toBe("Struktur disimpan.");
  });

  it("add, remove and edit chapters, then save sends the raw values", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: true });
    renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
    await userEvent.type(input("Tahun ajaran"), "2026/2027");
    const end = input("Halaman akhir bab 1");
    await userEvent.clear(end);
    await userEvent.type(end, "40");
    await userEvent.click(screen.getByRole("button", { name: "Hapus bab 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Tambah bab" }));
    await userEvent.type(input("Judul bab 2"), "Bab baru");
    await userEvent.selectOptions(screen.getByLabelText("Topik kurikulum bab 2"), TOPIC);
    await userEvent.click(save());
    await waitFor(() => {
      expect(mocks.confirmStructure).toHaveBeenCalledTimes(1);
    });
    expect(mocks.confirmStructure).toHaveBeenCalledWith({
      materialId: ID,
      values: {
        title: "Matematika Kelas VIII",
        grade: "8",
        academicYear: "2026/2027",
        chapters: [
          { title: "Pola Bilangan", pageStart: "3", pageEnd: "40", topicId: "" },
          { title: "Bab baru", pageStart: "41", pageEnd: "41", topicId: TOPIC },
        ],
      },
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the required fields marked for assistive technology without native validation", () => {
    renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
    for (const label of [
      "Judul",
      "Judul bab 1",
      "Halaman awal bab 1",
      "Halaman akhir bab 1",
    ]) {
      expect(input(label).getAttribute("aria-required"), label).toBe("true");
    }
    expect(input("Tahun ajaran").getAttribute("aria-required")).toBeNull();
  });

  it("clears the refused-save alert once the fields are fixed", async () => {
    renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
    await userEvent.clear(input("Judul"));
    await userEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe(INVALID);
    await userEvent.type(input("Judul"), "Buku");
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("");
    });
    expect(input("Judul").getAttribute("aria-invalid")).toBeNull();
  });

  it("disables adding a chapter at the limit and says why", async () => {
    const sections = Array.from({ length: 60 }, (_, index) => ({
      id: `s${String(index)}`,
      title: `Bab ${String(index + 1)}`,
      pageStart: index + 1,
      pageEnd: index + 1,
      topicId: null,
    }));
    renderWithIntl(
      <StructureEditor {...base} saved={{ ...base.saved, sections }} proposal={null} />,
    );
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Tambah bab" });
    expect(add.disabled).toBe(true);
    expect(screen.getByText("Paling banyak 60 bab.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Hapus bab 60" }));
    expect(add.disabled).toBe(false);
    expect(screen.queryByText("Paling banyak 60 bab.")).toBeNull();
  });

  it("starts a first chapter at page 1 and can be saved with none", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: true });
    renderWithIntl(<StructureEditor {...base} proposal={null} />);
    expect(screen.getByText(/Belum ada bab/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Tambah bab" }));
    expect(input("Halaman awal bab 1").value).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "Hapus bab 1" }));
    await userEvent.click(save());
    await waitFor(() => {
      expect(mocks.confirmStructure).toHaveBeenCalledTimes(1);
    });
    expect(structureFormSchema.safeParse(lastValues()).success).toBe(true);
    expect(lastValues()).toMatchObject({ chapters: [] });
  });

  describe("client and server agree", () => {
    const cases: [string, () => Promise<void>, string][] = [
      [
        "an empty title",
        async () => {
          await userEvent.clear(input("Judul"));
        },
        "Judul",
      ],
      [
        "a page end before the start",
        async () => {
          const end = input("Halaman akhir bab 1");
          await userEvent.clear(end);
          await userEvent.type(end, "2");
        },
        "Halaman akhir bab 1",
      ],
      [
        "a bad academic year",
        async () => {
          await userEvent.type(input("Tahun ajaran"), "2026/2030");
        },
        "Tahun ajaran",
      ],
    ];

    it.each(cases)(
      "refuses %s in the browser before the action, as the server schema does",
      async (_name, edit, label) => {
        renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
        await edit();
        await userEvent.click(save());
        await waitFor(() => {
          expect(input(label).getAttribute("aria-invalid")).toBe("true");
        });
        expect(document.activeElement).toBe(input(label));
        expect(screen.getByRole("alert").textContent).toBe(INVALID);
        expect(mocks.confirmStructure).not.toHaveBeenCalled();
        // The strings the form holds are refused by the schema the server parses with.
        const values = {
          title: input("Judul").value,
          grade: "8",
          academicYear: input("Tahun ajaran").value,
          chapters: [
            {
              title: input("Judul bab 1").value,
              pageStart: input("Halaman awal bab 1").value,
              pageEnd: input("Halaman akhir bab 1").value,
              topicId: "",
            },
          ],
        };
        expect(structureFormSchema.safeParse(values).success).toBe(false);
      },
    );

    it("accepts no chapters, as the server schema does", async () => {
      mocks.confirmStructure.mockResolvedValue({ ok: true });
      renderWithIntl(<StructureEditor {...base} proposal={null} />);
      await userEvent.click(save());
      await waitFor(() => {
        expect(mocks.confirmStructure).toHaveBeenCalledTimes(1);
      });
      expect(structureFormSchema.safeParse(lastValues()).success).toBe(true);
    });
  });

  it("a server pages error marks the chapter's last-page input and keeps the input", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: false, error: "pages" });
    renderWithIntl(<StructureEditor {...base} pageCount={50} proposal={proposal} />);
    await userEvent.click(screen.getByRole("button", { name: "Hapus bab 1" }));
    const end = input("Halaman akhir bab 1");
    await userEvent.clear(end);
    await userEvent.type(end, "55");
    await userEvent.click(save());
    await waitFor(() => {
      expect(end.getAttribute("aria-invalid")).toBe("true");
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Ada bab yang melewati halaman terakhir materi.",
    );
    expect(screen.getByText("Bab 1 melewati halaman terakhir materi (50).")).toBeTruthy();
    expect(end.value).toBe("55");
    expect(input("Judul").value).toBe("Matematika Kelas VIII");
    expect(input("Halaman awal bab 1").getAttribute("aria-invalid")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(end);
    });
    expect(save().disabled).toBe(false);
    // Fixing the page clears the mark.
    await userEvent.clear(end);
    await userEvent.type(end, "50");
    await waitFor(() => {
      expect(end.getAttribute("aria-invalid")).toBeNull();
    });
  });

  describe("an AI proposal", () => {
    const saved = {
      ...base.saved,
      title: "Matematika (tersimpan)",
      metadataConfirmedAt: "2026-11-20T03:00:00.000Z",
      sections: [
        { id: "s1", title: "Bab tersimpan", pageStart: 1, pageEnd: 10, topicId: null },
      ],
    };

    it("newer than the last confirmation fills the form and is marked as the AI's until saved", () => {
      const { rerender } = renderWithIntl(
        <StructureEditor
          {...base}
          saved={{ ...saved, metadataConfirmedAt: "2026-11-19T03:00:00.000Z" }}
          proposal={proposal}
        />,
      );
      expect(screen.getByText(PROPOSAL_NOTE)).toBeTruthy();
      expect(input("Judul").value).toBe("Matematika Kelas VIII");
      // The save lands and the page re-renders with the new confirmation: the mark goes, the
      // values stay.
      rerender(<StructureEditor {...base} saved={saved} proposal={proposal} />);
      expect(screen.queryByText(PROPOSAL_NOTE)).toBeNull();
      expect(input("Judul").value).toBe("Matematika Kelas VIII");
    });

    it("older than the last confirmation leaves the saved structure as it is", () => {
      renderWithIntl(<StructureEditor {...base} saved={saved} proposal={proposal} />);
      expect(screen.queryByText(PROPOSAL_NOTE)).toBeNull();
      expect(input("Judul").value).toBe("Matematika (tersimpan)");
      expect(input("Judul bab 1").value).toBe("Bab tersimpan");
      expect(screen.getByText(/Dikonfirmasi/)).toBeTruthy();
    });
  });

  describe("the live region", () => {
    it("announces a refusal as an alert and a save as a status", async () => {
      mocks.confirmStructure.mockResolvedValueOnce({ ok: false, error: "topic" });
      mocks.confirmStructure.mockResolvedValueOnce({ ok: true });
      renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
      await userEvent.click(save());
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Topik kurikulum tidak dikenal. Pilih ulang topiknya.",
      );
      await userEvent.click(save());
      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe("Struktur disimpan.");
      });
      expect(screen.getByRole("alert").textContent).toBe("");
    });

    it("keeps both regions mounted, and announces a failed request", async () => {
      mocks.requestStructure.mockResolvedValue({ ok: false, error: "notReady" });
      renderWithIntl(<StructureEditor {...base} proposal={null} />);
      expect(screen.getByRole("status").textContent).toBe("");
      expect(screen.getByRole("alert").textContent).toBe("");
      await userEvent.click(screen.getByRole("button", { name: "Usulkan dengan AI" }));
      expect(screen.getByRole("alert").textContent).toBe(
        "Teks materi belum selesai dibaca. Coba lagi nanti.",
      );
    });

    it("shows a failed proposal request after a refused save was fixed", async () => {
      mocks.requestStructure.mockResolvedValue({ ok: false, error: "limit" });
      renderWithIntl(<StructureEditor {...base} proposal={proposal} />);
      await userEvent.clear(input("Judul"));
      await userEvent.click(save());
      expect((await screen.findByRole("alert")).textContent).toBe(INVALID);
      await userEvent.type(input("Judul"), "Buku");
      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toBe("");
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Usulkan ulang dengan AI" }),
      );
      expect((await screen.findByRole("alert")).textContent).toMatch(/sudah habis/);
    });

    it("re-enables propose and save after a rejection", async () => {
      mocks.requestStructure.mockRejectedValue(new Error("network"));
      mocks.confirmStructure.mockRejectedValue(new Error("network"));
      renderWithIntl(<StructureEditor {...base} proposal={null} />);
      const propose = screen.getByRole<HTMLButtonElement>("button", {
        name: "Usulkan dengan AI",
      });
      await userEvent.click(propose);
      expect(screen.getByRole("alert").textContent).toBe("Terjadi kesalahan. Coba lagi.");
      expect(propose.disabled).toBe(false);
      await userEvent.click(save());
      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toBe(
          "Terjadi kesalahan. Coba lagi.",
        );
      });
      expect(save().disabled).toBe(false);
    });
  });

  it("asks for a proposal and follows the job", async () => {
    mocks.requestStructure.mockResolvedValue({ ok: true, jobId: "j1" });
    renderWithIntl(<StructureEditor {...base} proposal={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Usulkan dengan AI" }));
    expect(mocks.requestStructure).toHaveBeenCalledWith({ materialId: ID });
    expect(mocks.jobStatus).toHaveBeenLastCalledWith("j1");
    expect(screen.getByText(/AI sedang menyusun usulan struktur/)).toBeTruthy();
  });

  it("says when the day's AI suggestions are used up", async () => {
    mocks.requestStructure.mockResolvedValue({ ok: false, error: "limit" });
    renderWithIntl(<StructureEditor {...base} proposal={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Usulkan dengan AI" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Usulan AI untuk hari ini sudah habis (10 per hari). Coba lagi besok, atau isi strukturnya sendiri.",
    );
  });

  it("refreshes when the followed job succeeds and says when it failed", () => {
    mocks.jobStatus.mockReturnValue({
      data: { kind: "ok", job: { id: "j1", status: "succeeded" } },
    });
    renderWithIntl(
      <StructureEditor
        {...base}
        proposal={null}
        job={{ id: "j1", status: "running", errorCode: null }}
      />,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    mocks.jobStatus.mockReturnValue({ data: undefined });
    renderWithIntl(
      <StructureEditor
        {...base}
        proposal={null}
        job={{ id: "j2", status: "failed", errorCode: "structure_invalid_output" }}
      />,
    );
    expect(screen.getByText(/AI tidak dapat menyusun usulan/)).toBeTruthy();
  });

  it("cannot ask while the text is still being read", () => {
    renderWithIntl(<StructureEditor {...base} status="processing" proposal={null} />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Usulkan dengan AI" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("Usulan AI bisa diminta setelah teks selesai dibaca."),
    ).toBeTruthy();
  });
});
