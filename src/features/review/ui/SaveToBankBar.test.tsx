// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

const hook = vi.hoisted(() => ({ save: vi.fn(), pending: false }));
vi.mock("./use-bank-approved", () => ({
  useBankApproved: () => ({ save: hook.save, pending: hook.pending }),
}));

import { SaveToBankBar } from "./SaveToBankBar";

afterEach(cleanup);
beforeEach(() => {
  hook.save.mockReset();
  hook.pending = false;
});

describe("SaveToBankBar", () => {
  it("shows the ready count and a 44 px save button", () => {
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={3} approvedCount={3} totalCount={3} />,
    );
    expect(screen.getByText("3 soal disetujui siap disimpan")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Simpan ke Bank Soal" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.className).toContain("min-h-11");
  });

  it("disables the button and says so at zero", () => {
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={0} approvedCount={0} totalCount={0} />,
    );
    expect(screen.getByText("Belum ada soal yang disetujui")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Simpan ke Bank Soal" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows a disabled Menyimpan… button while pending", () => {
    hook.pending = true;
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={2} approvedCount={2} totalCount={2} />,
    );
    const button = screen.getByRole("button", { name: "Menyimpan…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Simpan ke Bank Soal" })).toBeNull();
  });

  it("switches to the pending state on click, before the save has answered", async () => {
    let release!: (value: unknown) => void;
    hook.save.mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={3} approvedCount={3} totalCount={3} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    const pending = screen.getByRole("button", { name: "Menyimpan…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    release({ ok: true, saved: 3 });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Simpan ke Bank Soal" })).toBeTruthy();
    });
  });

  it("keeps an always-mounted polite live region without a role", () => {
    const { container } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    expect(live.hasAttribute("role")).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("saves on click and announces the count with a link to the bank", async () => {
    hook.save.mockResolvedValue({ ok: true, saved: 2 });
    const { container } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={2} approvedCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe(
        "2 soal tersimpan",
      );
    });
    expect(hook.save).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("link", { name: "Buka Bank Soal" });
    expect(link.getAttribute("href")).toBe("/question-bank");
    expect(link.className).toContain("min-h-11");
  });

  it("says nothing new was saved for saved 0, keeps the link and shows no error", async () => {
    hook.save.mockResolvedValue({ ok: true, saved: 0 });
    const { container } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe(
        "Tidak ada soal baru untuk disimpan",
      );
    });
    expect(screen.getByRole("link", { name: "Buka Bank Soal" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the success line when the count drops after saving, and clears it on a new approval", async () => {
    hook.save.mockResolvedValue({ ok: true, saved: 2 });
    const { container, rerender } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={2} approvedCount={2} totalCount={2} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe(
        "2 soal tersimpan",
      );
    });
    rerender(
      <SaveToBankBar requestId="r" readyCount={0} approvedCount={0} totalCount={0} />,
    );
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe(
      "2 soal tersimpan",
    );
    rerender(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe("");
    expect(screen.queryByRole("link", { name: "Buka Bank Soal" })).toBeNull();
  });

  it("clears an error when the ready count changes", async () => {
    hook.save.mockResolvedValue({ ok: false, reason: "generic" });
    const { rerender } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    rerender(
      <SaveToBankBar requestId="r" readyCount={2} approvedCount={2} totalCount={2} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an alert for a generic failure and for a signed-out session", async () => {
    hook.save.mockResolvedValue({ ok: false, reason: "generic" });
    const { unmount } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Soal belum tersimpan. Coba lagi.",
      );
    });
    unmount();

    hook.save.mockResolvedValue({ ok: false, reason: "signed_out" });
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Simpan ke Bank Soal" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Sesi berakhir. Masuk lagi untuk melanjutkan.",
      );
    });
  });

  it("is sticky in normal flow, never fixed, so it cannot cover the last card (B-003)", () => {
    const { container } = renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={1} approvedCount={1} totalCount={1} />,
    );
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain("sticky");
    expect(cls).toContain(
      "bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))]",
    );
    expect(cls).toContain("md:bottom-0");
    expect(cls).not.toContain("fixed");
  });

  it("shows 'N dari M disetujui' progress", () => {
    renderWithIntl(
      <SaveToBankBar requestId="r" readyCount={2} approvedCount={2} totalCount={5} />,
    );
    expect(screen.getByText("2 dari 5 disetujui")).toBeTruthy();
  });
});
