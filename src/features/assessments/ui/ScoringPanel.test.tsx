// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  setScoringModeAction: vi.fn(() => Promise.resolve({ ok: true })),
  setPointsAction: vi.fn(() => Promise.resolve({ ok: true })),
  setShuffleAction: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("../actions/scoring", () => mocks);

import type { RunEditorAction } from "./use-editor-run";
import { ScoringPanel } from "./ScoringPanel";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const items = [
  { itemId: "i1", number: 1, points: 1 },
  { itemId: "i2", number: 2, points: 3 },
];
const run = vi.fn<RunEditorAction>((work) => {
  void work();
});

function renderPanel(props: Partial<Parameters<typeof ScoringPanel>[0]> = {}) {
  return renderWithIntl(
    <ScoringPanel
      assessmentId={ID}
      mode="equal"
      shuffled={false}
      items={items}
      locked={false}
      busy={false}
      run={run}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ScoringPanel", () => {
  it("offers the three modes as a labelled radio group and saves a change", async () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Cara penilaian" });
    expect(
      within(group).getByRole<HTMLInputElement>("radio", { name: /Sama rata/ }).checked,
    ).toBe(true);
    await userEvent.click(within(group).getByRole("radio", { name: /dijadikan 100/ }));
    expect(mocks.setScoringModeAction).toHaveBeenCalledWith({
      assessmentId: ID,
      mode: "normalised",
    });
  });

  it("equal: shows the split and a total of exactly 100, no point inputs", () => {
    renderPanel();
    expect(screen.queryByRole("textbox", { name: /Skor soal/ })).toBeNull();
    expect(screen.getByText("Total skor: 100")).toBeTruthy();
  });

  it("manual: one labelled input per question, live total, saves what was typed", async () => {
    renderPanel({ mode: "manual" });
    const first = screen.getByRole("textbox", { name: "Skor soal 1" });
    expect((first as HTMLInputElement).value).toBe("1");
    expect(screen.getByText("Total skor: 4")).toBeTruthy();
    await userEvent.clear(first);
    await userEvent.type(first, "2,5");
    expect(screen.getByText("Total skor: 5,5")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Simpan skor" }));
    await waitFor(() => {
      expect(mocks.setPointsAction).toHaveBeenCalledWith({
        assessmentId: ID,
        points: { i1: "2,5", i2: "3" },
      });
    });
  });

  it('accepts "2,5" and "2.5", marks only the row that is not a number, and the total follows typing', async () => {
    renderPanel({ mode: "manual" });
    const first = screen.getByRole("textbox", { name: "Skor soal 1" });
    const second = screen.getByRole("textbox", { name: "Skor soal 2" });
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Simpan skor" });
    await userEvent.clear(first);
    await userEvent.type(first, "2.5");
    expect(screen.getByText("Total skor: 5,5")).toBeTruthy();
    await userEvent.clear(second);
    await userEvent.type(second, "2,5");
    expect(screen.getByText("Total skor: 5")).toBeTruthy();
    expect(first.getAttribute("aria-invalid")).toBeNull();
    expect(second.getAttribute("aria-invalid")).toBeNull();
    expect(save.disabled).toBe(false);

    await userEvent.clear(second);
    await userEvent.type(second, "abc");
    expect(second.getAttribute("aria-invalid")).toBe("true");
    expect(first.getAttribute("aria-invalid")).toBeNull();
    expect(save.disabled).toBe(true);
    expect(mocks.setPointsAction).not.toHaveBeenCalled();
  });

  it("marks an entry of 0 and does not save", async () => {
    renderPanel({ mode: "manual" });
    const first = screen.getByRole("textbox", { name: "Skor soal 1" });
    await userEvent.clear(first);
    await userEvent.type(first, "0");
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Simpan skor" }).disabled,
    ).toBe(true);
  });

  it("keeps the typed strings when the server refuses the points", async () => {
    mocks.setPointsAction.mockResolvedValueOnce({
      ok: false,
      reason: "invalidPoints",
    } as never);
    const refusing = vi.fn<RunEditorAction>((work) => {
      void work();
    });
    renderPanel({ mode: "manual", run: refusing });
    const first = screen.getByRole<HTMLInputElement>("textbox", { name: "Skor soal 1" });
    await userEvent.clear(first);
    await userEvent.type(first, "2,5");
    await userEvent.click(screen.getByRole("button", { name: "Simpan skor" }));
    await waitFor(() => {
      expect(mocks.setPointsAction).toHaveBeenCalledTimes(1);
    });
    expect(first.value).toBe("2,5");
    expect(screen.getByText("Total skor: 5,5")).toBeTruthy();
  });

  it("normalised: shows each scaled share and a total of 100", () => {
    renderPanel({ mode: "normalised" });
    expect(screen.getByText("Menjadi 25 poin")).toBeTruthy();
    expect(screen.getByText("Menjadi 75 poin")).toBeTruthy();
    expect(screen.getByText("Total skor: 100")).toBeTruthy();
  });

  it("turns the shuffle on and off, and reshuffles only while on", async () => {
    const { unmount } = renderPanel();
    expect(screen.queryByRole("button", { name: "Acak ulang" })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: /Acak urutan soal/ }));
    expect(mocks.setShuffleAction).toHaveBeenLastCalledWith({
      assessmentId: ID,
      mode: "on",
    });
    unmount();
    renderPanel({ shuffled: true });
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: /Acak urutan soal/ })
        .checked,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Acak ulang" }));
    expect(mocks.setShuffleAction).toHaveBeenLastCalledWith({
      assessmentId: ID,
      mode: "reshuffle",
    });
    await userEvent.click(screen.getByRole("checkbox", { name: /Acak urutan soal/ }));
    expect(mocks.setShuffleAction).toHaveBeenLastCalledWith({
      assessmentId: ID,
      mode: "off",
    });
  });

  it("is read-only while locked", () => {
    renderPanel({ mode: "manual", shuffled: true, locked: true });
    for (const radio of screen.getAllByRole("radio"))
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("textbox", { name: "Skor soal 1" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("checkbox", { name: /Acak urutan soal/ })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Acak ulang" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Simpan skor" }).disabled,
    ).toBe(true);
  });
});

describe("ScoringPanel focus, formatting and targets", () => {
  const focusOf = (index = 0) => {
    const focus = vi.mocked(run).mock.calls[index][1].focus;
    if (!Array.isArray(focus)) throw new Error("no focus ids");
    return document.getElementById(focus[0]);
  };

  it("keeps the keyboard on the control that was used", async () => {
    renderPanel({ mode: "manual", shuffled: true });
    const normalised = screen.getByRole("radio", { name: /dijadikan 100/ });
    await userEvent.click(normalised);
    expect(focusOf(0)).toBe(normalised);
    const box = screen.getByRole("checkbox", { name: /Acak urutan soal/ });
    await userEvent.click(box);
    expect(focusOf(1)).toBe(box);
    const again = screen.getByRole("button", { name: "Acak ulang" });
    await userEvent.click(again);
    expect(focusOf(2)).toBe(again);
    const save = screen.getByRole("button", { name: "Simpan skor" });
    await userEvent.click(save);
    await waitFor(() => {
      expect(focusOf(3)).toBe(save);
    });
  });

  it("the whole mode row is the label (44 px target)", () => {
    renderPanel();
    const radio = screen.getByRole("radio", { name: /Manual, dijadikan 100/ });
    const row = radio.closest("label");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("min-h-11");
  });

  it("shows stored points with the locale's decimal separator", () => {
    renderPanel({ mode: "manual", items: [{ itemId: "i1", number: 1, points: 2.5 }] });
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Skor soal 1" }).value,
    ).toBe("2,5");
  });

  it("does not announce the total on every keystroke; save is described by it", () => {
    renderPanel({ mode: "manual" });
    const total = screen.getByText("Total skor: 4");
    expect(total.closest("[aria-live]")).toBeNull();
    const save = screen.getByRole("button", { name: "Simpan skor" });
    expect(save.getAttribute("aria-describedby")).toBe(total.id);
  });
});
