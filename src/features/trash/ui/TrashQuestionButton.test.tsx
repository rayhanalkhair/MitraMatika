// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  trash: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));
vi.mock("../actions/trash", () => ({ trashQuestionAction: mocks.trash }));

import { TrashQuestionButton } from "./TrashQuestionButton";

const ID = "11111111-1111-4111-8111-111111111111";

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
  mocks.trash.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const confirmButton = () =>
  within(screen.getByRole("dialog")).getByRole("button", { name: "Pindahkan ke Sampah" });

describe("TrashQuestionButton", () => {
  it("asks before moving the question to the trash, then leaves the detail page", async () => {
    renderWithIntl(
      <TrashQuestionButton questionId={ID} topic="Pecahan" afterTrash="/question-bank" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Pecahan" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Pindahkan soal ke Sampah?" });
    expect(dialog.textContent).toContain("30 hari");
    expect(mocks.trash).not.toHaveBeenCalled();
    await userEvent.click(confirmButton());
    expect(mocks.trash).toHaveBeenCalledWith({ questionId: ID });
    expect(mocks.push).toHaveBeenCalledWith("/question-bank");
  });

  it("on a card it re-reads the list; cancel does nothing and returns focus", async () => {
    renderWithIntl(<TrashQuestionButton questionId={ID} topic="Pecahan" compact />);
    const opener = screen.getByRole("button", { name: "Pindahkan ke Sampah: Pecahan" });
    expect(opener.className).toContain("size-11");
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(mocks.trash).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);

    await userEvent.click(opener);
    await userEvent.click(confirmButton());
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("on a card, moves focus to the page heading once the card is about to go", async () => {
    renderWithIntl(
      <>
        <h1>Bank Soal</h1>
        <TrashQuestionButton questionId={ID} topic="Pecahan" compact />
      </>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Pecahan" }),
    );
    await userEvent.click(confirmButton());
    const heading = screen.getByRole("heading", { level: 1 });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("shows a refusal in the dialog", async () => {
    mocks.trash.mockResolvedValue({ ok: false, reason: "not_found" });
    renderWithIntl(<TrashQuestionButton questionId={ID} topic="Pecahan" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Pecahan" }),
    );
    await userEvent.click(confirmButton());
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(
      "Soal ini tidak ditemukan. Muat ulang halaman.",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
