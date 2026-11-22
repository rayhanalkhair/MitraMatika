// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({ trash: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/features/trash/actions/assessment", () => ({
  trashAssessmentAction: mocks.trash,
}));
import type { AssessmentListItem } from "../service/assessments";
import { AssessmentList } from "./AssessmentList";

afterEach(cleanup);

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

const ITEMS: AssessmentListItem[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    title: "STS ganjil",
    kind: "sts",
    grade: 8,
    status: "approved",
    examDate: null,
    itemCount: 20,
    sectionCount: 2,
    updatedAt: "2026-11-18T03:00:00.000Z",
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    title: "Latihan SPLDV",
    kind: "latihan",
    grade: 8,
    status: "draft",
    examDate: null,
    itemCount: 0,
    sectionCount: 1,
    updatedAt: "2026-11-10T03:00:00.000Z",
  },
];

describe("AssessmentList", () => {
  it("lists the assessments in the given order, each a link to its editor with a status chip and counts", () => {
    renderWithIntl(<AssessmentList items={ITEMS} />);
    const list = screen.getByRole("list", { name: "Daftar asesmen" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      `/assessment-builder/${ITEMS[0].id}`,
      `/assessment-builder/${ITEMS[1].id}`,
    ]);
    expect(within(rows[0]).getByText("STS ganjil")).toBeTruthy();
    expect(within(rows[0]).getByText("Disetujui")).toBeTruthy();
    expect(within(rows[0]).getByText("STS")).toBeTruthy();
    expect(within(rows[0]).getByText("20 soal")).toBeTruthy();
    expect(within(rows[0]).getByText("2 bagian")).toBeTruthy();
    expect(within(rows[1]).getByText("Draf")).toBeTruthy();
    expect(within(rows[1]).getByText("Belum ada soal")).toBeTruthy();
    expect(within(rows[1]).getByText("Kelas 8")).toBeTruthy();
  });

  it("offers a move to the trash beside each link (not inside it), behind a confirmation", async () => {
    mocks.trash.mockResolvedValue({ ok: true });
    renderWithIntl(<AssessmentList items={ITEMS} />);
    const button = screen.getByRole("button", {
      name: "Pindahkan ke Sampah: Latihan SPLDV",
    });
    expect(button.closest("a")).toBeNull();
    expect(button.className).toContain("size-11");
    await userEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Pindahkan asesmen ke Sampah?" });
    expect(mocks.trash).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Pindahkan ke Sampah" }),
    );
    expect(mocks.trash).toHaveBeenCalledWith({ id: ITEMS[1].id });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows an empty state", () => {
    renderWithIntl(<AssessmentList items={[]} />);
    expect(screen.getByText("Belum ada asesmen")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
