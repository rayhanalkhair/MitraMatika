// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({ restore: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/features/bank/actions/restore-version", () => ({
  restoreVersionAction: mocks.restore,
}));
import type { ReviewQuestion } from "@/features/review";
import type { VersionSummary } from "../service/versions";
import { VersionHistory } from "./VersionHistory";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.restore.mockResolvedValue({ ok: true, versionId: "v3" });
});
afterEach(cleanup);

const versions: VersionSummary[] = [
  {
    id: "v2",
    versionNo: 2,
    author: "ai",
    changeKind: "regenerated",
    createdAt: "2026-11-09T10:00:00.000Z",
    status: "ketidaksesuaian",
    isCurrent: true,
  },
  {
    id: "v1",
    versionNo: 1,
    author: "ai",
    changeKind: "generated",
    createdAt: "2026-11-08T10:00:00.000Z",
    status: "terverifikasi",
    isCurrent: false,
  },
];

function question(versionId: string, versionNo: number, stem: string): ReviewQuestion {
  return {
    questionId: "q1",
    versionId,
    versionNo,
    rowVersion: 4,
    decision: "draft",
    override: false,
    banked: false,
    difficulty: "sedang",
    stemMd: stem,
    options: [
      { label: "A", textMd: "3" },
      { label: "B", textMd: "4" },
      { label: "C", textMd: "5" },
      { label: "D", textMd: "6" },
    ],
    correctLabel: "B",
    answerDisplayMd: "4",
    explanationMd: "",
    steps: [],
    sources: [],
    verification: {
      status: "terverifikasi",
      checked: true,
      checks: [],
      crossCheck: null,
      regenerated: false,
      regenerationFailed: false,
    },
  };
}

const props = {
  questionId: "q1",
  rowVersion: 4,
  versions,
  historyPath: "/question-bank/q1/history",
};

describe("VersionHistory", () => {
  it("lists the versions newest first with author, kind, date and status", () => {
    renderWithIntl(<VersionHistory {...props} selected={null} />);
    const items = within(screen.getByRole("list", { name: "Daftar versi" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Versi 2");
    expect(items[0].textContent).toContain("Versi saat ini");
    expect(items[0].textContent).toContain("Dibuat ulang");
    expect(items[0].textContent).toContain("Dibuat AI");
    expect(items[0].textContent).toContain("9 November 2026");
    expect(items[0].textContent).toContain("Ditemukan ketidaksesuaian");
    expect(items[1].textContent).toContain("Versi 1");
    expect(items[1].textContent).toContain("Terverifikasi otomatis");
    expect(screen.getByText("Pilih versi untuk melihat isinya.")).toBeTruthy();
  });

  it("links each version and marks the open one", () => {
    renderWithIntl(
      <VersionHistory
        {...props}
        selected={question("v1", 1, "Hitung $1+1$.")}
        selectedId="v1"
      />,
    );
    const link = screen.getByRole("link", { name: /Versi 1/ });
    expect(link.getAttribute("href")).toBe("/question-bank/q1/history?version=v1");
    expect(link.getAttribute("aria-current")).toBe("true");
  });

  it("shows the chosen version read-only and restores it from the button", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VersionHistory
        {...props}
        selected={question("v1", 1, "Hitung $1+1$.")}
        selectedId="v1"
      />,
    );
    expect(screen.getByText("Hanya dibaca. Versi ini tidak bisa diubah.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    const button = screen.getByRole("button", { name: "Pulihkan versi ini" });
    expect(button.className).toContain("min-h-11");

    await user.click(button);

    expect(mocks.restore).toHaveBeenCalledWith({
      questionId: "q1",
      versionId: "v1",
      expectedRowVersion: 4,
    });
    const status = await screen.findByText("Versi dipulihkan sebagai versi baru.");
    expect(mocks.refresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(status.closest("[role=status]")).toBe(document.activeElement);
    });
  });

  it("hides the restore button after a restore and links to the current version", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VersionHistory
        {...props}
        selected={question("v1", 1, "Hitung $1+1$.")}
        selectedId="v1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pulihkan versi ini" }));
    await screen.findByText("Versi dipulihkan sebagai versi baru.");
    expect(screen.queryByRole("button", { name: "Pulihkan versi ini" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Lihat versi saat ini" }).getAttribute("href"),
    ).toBe("/question-bank/q1/history?version=v2");
  });

  it("offers no restore for the current version", () => {
    renderWithIntl(
      <VersionHistory
        {...props}
        selected={question("v2", 2, "Hitung $2+2$.")}
        selectedId="v2"
      />,
    );
    expect(screen.queryByRole("button", { name: "Pulihkan versi ini" })).toBeNull();
    expect(screen.getByText("Ini versi yang sedang dipakai.")).toBeTruthy();
  });

  it.each([
    ["stale", "Soal sudah berubah di tempat lain. Muat ulang halaman, lalu coba lagi."],
    ["not_ready", "Soal ini sedang dibuat ulang. Tunggu sampai selesai, lalu coba lagi."],
    ["current", "Versi ini sudah menjadi versi saat ini."],
    ["trashed", "Soal ini ada di sampah dan tidak bisa dipulihkan."],
    ["not_found", "Versi tidak ditemukan."],
    ["signed_out", "Sesi berakhir. Silakan masuk kembali."],
    ["generic", "Versi belum dipulihkan. Coba lagi."],
  ])(
    "shows the %s refusal as a clear message and does not refresh",
    async (reason, text) => {
      mocks.restore.mockResolvedValue({ ok: false, reason });
      const user = userEvent.setup();
      renderWithIntl(
        <VersionHistory
          {...props}
          selected={question("v1", 1, "Hitung $1+1$.")}
          selectedId="v1"
        />,
      );
      await user.click(screen.getByRole("button", { name: "Pulihkan versi ini" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
});
