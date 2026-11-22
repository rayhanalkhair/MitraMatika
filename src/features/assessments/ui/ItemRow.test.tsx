// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const actions = vi.hoisted(() => ({
  moveItemAction: vi.fn(() => Promise.resolve({ ok: true })),
  removeItemAction: vi.fn(() => Promise.resolve({ ok: true })),
  updateItemToLatestAction: vi.fn(() => Promise.resolve({ ok: true, changed: true })),
}));
vi.mock("../actions/edit-items", () => actions);

import type { EditorItem } from "../service/editor-items";
import { ItemRow } from "./ItemRow";

const ITEM: EditorItem = {
  itemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  sectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  questionId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  versionId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  versionNo: 2,
  points: 0,
  difficulty: "sedang",
  stemMd: "Hitung $1 + 1$.",
  options: [
    { label: "A", textMd: "1" },
    { label: "B", textMd: "2" },
    { label: "C", textMd: "3" },
    { label: "D", textMd: "4" },
  ],
  correctLabel: "B",
  state: "ok",
  newerVersionAvailable: false,
  canUpdate: false,
};
const SECTIONS = [
  { id: ITEM.sectionId, title: "A. Pilihan ganda" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", title: "B. Uraian" },
];

const run = vi.fn();
function renderRow(
  overrides: Partial<EditorItem> = {},
  props: Partial<Parameters<typeof ItemRow>[0]> = {},
) {
  return renderWithIntl(
    <ol>
      <ItemRow
        item={{ ...ITEM, ...overrides }}
        number={3}
        index={1}
        size={3}
        sections={SECTIONS}
        locked={false}
        busy={false}
        run={run}
        {...props}
      />
    </ol>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ItemRow", () => {
  it("shows the pinned question with its number, version, key and options", () => {
    renderRow();
    expect(screen.getByRole("listitem", { name: "Soal 3" })).toBeTruthy();
    expect(screen.getByText("Versi 2")).toBeTruthy();
    expect(screen.getByText("Kunci: B")).toBeTruthy();
    expect(screen.getByText("Sedang")).toBeTruthy();
    expect(screen.queryByText("Ada versi terbaru")).toBeNull();
  });

  it("always has labelled up and down buttons, 44 px wide, that move within the section", async () => {
    renderRow();
    const up = screen.getByRole("button", { name: "Naikkan soal 3" });
    const down = screen.getByRole("button", { name: "Turunkan soal 3" });
    expect(up.className).toContain("size-11");
    expect(down.className).toContain("size-11");

    await userEvent.click(up);
    const [work, { focus }] = run.mock.calls[0] as [
      () => Promise<unknown>,
      { focus: string[] },
    ];
    await work();
    expect(actions.moveItemAction).toHaveBeenCalledWith({
      itemId: ITEM.itemId,
      toSectionId: ITEM.sectionId,
      toIndex: 0,
    });
    expect(focus).toEqual([`item-${ITEM.itemId}-up`, `item-${ITEM.itemId}-down`]);

    await userEvent.click(down);
    await (run.mock.calls[1][0] as () => Promise<unknown>)();
    expect(actions.moveItemAction).toHaveBeenLastCalledWith({
      itemId: ITEM.itemId,
      toSectionId: ITEM.sectionId,
      toIndex: 2,
    });
  });

  it("works from the keyboard", async () => {
    renderRow();
    const down = screen.getByRole("button", { name: "Turunkan soal 3" });
    down.focus();
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("disables up on the first item of a section and down on the last, but keeps both", () => {
    renderRow({}, { index: 0 });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Naikkan soal 3" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Turunkan soal 3" }).disabled,
    ).toBe(false);
    cleanup();
    renderRow({}, { index: 2 });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Turunkan soal 3" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Naikkan soal 3" }).disabled,
    ).toBe(false);
  });

  it("moves the item to the end of another section with the select", async () => {
    renderRow();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Pindahkan soal 3 ke bagian" }),
      "B. Uraian",
    );
    await (run.mock.calls[0][0] as () => Promise<unknown>)();
    expect(actions.moveItemAction).toHaveBeenCalledWith({
      itemId: ITEM.itemId,
      toSectionId: SECTIONS[1].id,
      toIndex: Number.MAX_SAFE_INTEGER,
    });
  });

  it("has no section select when there is only one section", () => {
    renderRow({}, { sections: [SECTIONS[0]] });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("removes the item", async () => {
    renderRow();
    await userEvent.click(screen.getByRole("button", { name: "Keluarkan soal 3" }));
    await (run.mock.calls[0][0] as () => Promise<unknown>)();
    expect(actions.removeItemAction).toHaveBeenCalledWith({ itemId: ITEM.itemId });
  });

  it("flags a newer version and offers to update only when the question is in the bank", async () => {
    renderRow({ newerVersionAvailable: true, canUpdate: true });
    expect(screen.getByText("Ada versi terbaru")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Pakai versi terbaru soal 3" }),
    );
    await (run.mock.calls[0][0] as () => Promise<unknown>)();
    expect(actions.updateItemToLatestAction).toHaveBeenCalledWith({
      itemId: ITEM.itemId,
    });
    cleanup();
    renderRow({ newerVersionAvailable: true, canUpdate: false, state: "unbanked" });
    expect(screen.getByText("Ada versi terbaru")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pakai versi terbaru/ })).toBeNull();
  });

  it("warns about a trashed and an unbanked question", () => {
    renderRow({ state: "trashed" });
    expect(screen.getByText(/ada di Sampah/)).toBeTruthy();
    cleanup();
    renderRow({ state: "unbanked" });
    expect(screen.getByText(/tidak lagi ada di Bank Soal/)).toBeTruthy();
  });

  it("disables every control while locked or busy", () => {
    renderRow({ newerVersionAvailable: true, canUpdate: true }, { locked: true });
    for (const control of [
      ...screen.getAllByRole("button"),
      screen.getByRole("combobox"),
    ]) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
    cleanup();
    renderRow({}, { busy: true });
    for (const control of screen.getAllByRole("button")) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
