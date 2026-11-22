// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  approveAction: vi.fn(() => Promise.resolve({ ok: true })),
  reopenAction: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../actions/approval", () => mocks);

import type { ApprovalState } from "../service/approval";
import { ApprovalPanel } from "./ApprovalPanel";
import type { RunEditorAction } from "./use-editor-run";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HASH = "a".repeat(64);
const run = vi.fn<RunEditorAction>((work) => {
  void work();
});

const state = (over: Partial<ApprovalState> = {}): ApprovalState => ({
  problems: [],
  hash: HASH,
  approved: false,
  approvedAt: null,
  stale: false,
  ...over,
});

function renderPanel(over: Partial<ApprovalState> = {}, busy = false) {
  return renderWithIntl(
    <ApprovalPanel assessmentId={ID} state={state(over)} busy={busy} run={run} />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ApprovalPanel", () => {
  it("approves a ready assessment with the hash the page saw", async () => {
    renderPanel();
    expect(screen.getByText(/Siap disetujui/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Setujui asesmen" }));
    expect(mocks.approveAction).toHaveBeenCalledWith({
      assessmentId: ID,
      expectedHash: HASH,
    });
  });

  it("lists every problem with a link to the item number and disables approve with the reason", () => {
    renderPanel({
      problems: [
        { code: "trashed", template: true },
        { code: "trashed", itemId: "i1", number: 1 },
        { code: "notApproved", itemId: "i2", number: 2 },
        { code: "mismatch", itemId: "i3", number: 3 },
        {
          code: "badTotal",
          mode: "manual",
          total: 0,
          unscored: [{ itemId: "i4", number: 4 }],
        },
      ],
    });
    const list = screen.getByRole("list", { name: /perlu diselesaikan/ });
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "Templat dokumen ada di Sampah. Pulihkan di Sampah atau pilih templat lain.",
      "Soal 1 ada di Sampah.",
      "Soal 2 belum disetujui atau tidak lagi ada di Bank Soal.",
      "Soal 3 memiliki ketidaksesuaian yang belum diselesaikan. Setujui dengan catatan di Tinjau Soal, atau keluarkan.",
      "Total skor harus lebih dari 0.",
      "Soal 4 belum punya skor.",
    ]);
    expect(
      within(list)
        .getByRole("link", {
          name: "Soal 3 memiliki ketidaksesuaian yang belum diselesaikan. Setujui dengan catatan di Tinjau Soal, atau keluarkan.",
        })
        .getAttribute("href"),
    ).toBe("#item-i3");
    const approve = screen.getByRole("button", { name: "Setujui asesmen" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    const describedBy = approve.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toMatch(
      /6 hal perlu diselesaikan/,
    );
  });

  it("names the total when equal or normalised does not reach 100, and an empty assessment", () => {
    renderPanel({
      problems: [{ code: "badTotal", mode: "normalised", total: 0, unscored: [] }],
    });
    expect(screen.getByText("Total skor 0 belum tepat 100.")).toBeTruthy();
    cleanup();
    renderPanel({ problems: [{ code: "empty" }] });
    expect(screen.getByText("Belum ada soal di asesmen ini.")).toBeTruthy();
  });

  it("reopens only after a confirmation; cancel keeps it approved", async () => {
    renderPanel({ approved: true, approvedAt: "2026-11-19T03:00:00.000Z" });
    expect(screen.getByText("Disetujui pada 19 November 2026.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui asesmen" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Buka kembali" }));
    const confirm = screen.getByRole("group", { name: "Buka kembali asesmen ini?" });
    expect(document.activeElement).toBe(
      within(confirm).getByRole("button", { name: "Batal" }),
    );
    await userEvent.click(within(confirm).getByRole("button", { name: "Batal" }));
    expect(mocks.reopenAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Buka kembali" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Buka kembali" }));
    await userEvent.click(screen.getByRole("button", { name: "Ya, buka kembali" }));
    expect(mocks.reopenAction).toHaveBeenCalledWith({ assessmentId: ID });
  });

  it("warns when the approval no longer matches the assessment", () => {
    renderPanel({ approved: true, approvedAt: "2026-11-19T03:00:00.000Z", stale: true });
    expect(screen.getByRole("alert").textContent).toMatch(
      /Ada perubahan sejak asesmen disetujui/,
    );
  });

  it("names a trashed template as the reason of a stale approval", () => {
    renderPanel({
      approved: true,
      approvedAt: "2026-11-19T03:00:00.000Z",
      stale: true,
      problems: [{ code: "trashed", template: true }],
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /Ada perubahan sejak asesmen disetujui.*Templat dokumen ada di Sampah/,
    );
  });

  it("disables the buttons while an action runs", () => {
    renderPanel({}, true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Setujui asesmen" }).disabled,
    ).toBe(true);
  });
});

describe("ApprovalPanel focus and refusals", () => {
  const options = (index = 0) => run.mock.calls[index][1];

  it("approve sends focus to the reopen button that replaces it, reopen back to approve", async () => {
    const view = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Setujui asesmen" }));
    const afterApprove = options().focus;
    if (!Array.isArray(afterApprove)) throw new Error("no focus ids");
    view.rerender(
      <ApprovalPanel
        assessmentId={ID}
        state={state({ approved: true, approvedAt: "2026-11-19T03:00:00.000Z" })}
        busy={false}
        run={run}
      />,
    );
    const reopen = screen.getByRole("button", { name: "Buka kembali" });
    expect(document.getElementById(afterApprove[0])).toBe(reopen);

    await userEvent.click(reopen);
    await userEvent.click(screen.getByRole("button", { name: "Ya, buka kembali" }));
    const afterReopen = options(1).focus;
    if (!Array.isArray(afterReopen)) throw new Error("no focus ids");
    view.rerender(
      <ApprovalPanel assessmentId={ID} state={state()} busy={false} run={run} />,
    );
    expect(document.getElementById(afterReopen[0])).toBe(
      screen.getByRole("button", { name: "Setujui asesmen" }),
    );
  });

  it("a refused approve refreshes the page and shows the problems it returned", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Setujui asesmen" }));
    const { refused, refreshOnRefusal } = options();
    expect(refreshOnRefusal).toBe(true);
    let message: string | null = null;
    act(() => {
      message =
        refused?.({
          ok: false,
          reason: "notReady",
          problems: [{ code: "mismatch", itemId: "i7", number: 7 }],
        }) ?? null;
    });
    expect(message).toMatch(/belum siap disetujui/);
    expect(
      screen
        .getByRole("link", { name: /Soal 7 memiliki ketidaksesuaian/ })
        .getAttribute("href"),
    ).toBe("#item-i7");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Setujui asesmen" }).disabled,
    ).toBe(true);
    expect(refused?.({ ok: false, reason: "conflict" })).toMatch(
      /berubah sejak halaman dimuat/,
    );
  });

  it("a stale approval says export waits for a new approval, next to reopen", () => {
    renderPanel({ approved: true, approvedAt: "2026-11-19T03:00:00.000Z", stale: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Buka kembali, lalu setujui lagi/);
    const reopen = screen.getByRole("button", { name: "Buka kembali" });
    expect(reopen.getAttribute("aria-describedby")).toBe(alert.id);
  });
});
