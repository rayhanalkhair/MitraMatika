// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { DeleteAccountState } from "@/features/auth";

const action = vi.hoisted(() => ({
  fn: vi.fn<
    (previous: DeleteAccountState, data: FormData) => Promise<DeleteAccountState>
  >(() => Promise.resolve({})),
}));
vi.mock("@/features/settings/actions/delete-account", () => ({
  deleteAccountAction: action.fn,
}));
vi.mock("@/features/auth/actions/actions", () => ({ signOutAction: vi.fn() }));

import { DeleteAccountDialog } from "./DeleteAccountDialog";

const EMAIL = "sari@example.test";

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
  action.fn.mockReset();
  action.fn.mockResolvedValue({});
});
afterEach(cleanup);

async function open() {
  await userEvent.click(screen.getByRole("button", { name: "Hapus akun" }));
  return screen.getByRole("dialog", { name: "Hapus akun untuk selamanya?" });
}

describe("DeleteAccountDialog", () => {
  it("explains what is deleted and opens a dialog that asks for the account email", async () => {
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    expect(screen.getByRole("heading", { level: 3, name: "Hapus akun" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await open();
    const input = screen.getByLabelText(`Ketik ${EMAIL}`);
    expect(dialog.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("refuses an address that is not exactly the account email, without calling the server", async () => {
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    const input = screen.getByLabelText(`Ketik ${EMAIL}`);
    await userEvent.type(input, "Sari@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    const error = screen.getByText("Email yang diketik tidak sama dengan email akun.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(input);
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("sends the typed address when it matches", async () => {
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    expect(action.fn.mock.calls[0][1].get("confirmEmail")).toBe(EMAIL);
  });

  it("shows a server failure inside the dialog", async () => {
    action.fn.mockResolvedValue({ error: "generic" });
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Terjadi kesalahan. Coba lagi.",
    );
  });

  it("cancel closes the dialog and gives focus back to the button that opened it", async () => {
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Hapus akun" }),
    );
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("asks a password account for its current password and sends it", async () => {
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword />);
    await open();
    const password = screen.getByLabelText("Kata sandi saat ini");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.type(password, "rahasia123");
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    expect(action.fn.mock.calls[0][1].get("currentPassword")).toBe("rahasia123");
  });

  it("shows a wrong password on the password field", async () => {
    action.fn.mockResolvedValue({ fieldErrors: { currentPassword: "wrongPassword" } });
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword />);
    await open();
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.type(screen.getByLabelText("Kata sandi saat ini"), "salah1234");
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    const error = await screen.findByText("Kata sandi saat ini salah.");
    const password = screen.getByLabelText("Kata sandi saat ini");
    expect(password.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(password);
  });

  it("tells an account without a password about the recent sign-in, and offers to sign out when it is too old", async () => {
    action.fn.mockResolvedValue({ error: "signInAgain" });
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    expect(screen.queryByLabelText("Kata sandi saat ini")).toBeNull();
    expect(
      screen.getByText(
        "Untuk keamanan, akun tanpa kata sandi hanya bisa dihapus dalam 10 menit setelah masuk.",
      ),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    expect((await screen.findByRole("alert")).textContent).toContain("masuk lagi dulu");
    expect(screen.getByRole("button", { name: "Keluar sekarang" })).toBeTruthy();
  });

  it("an earlier error does not show again when the dialog is opened again", async () => {
    action.fn.mockResolvedValue({ error: "generic" });
    renderWithIntl(<DeleteAccountDialog email={EMAIL} hasPassword={false} />);
    await open();
    await userEvent.type(screen.getByLabelText(`Ketik ${EMAIL}`), EMAIL);
    await userEvent.click(screen.getByRole("button", { name: "Hapus akun saya" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Batal" }));
    await open();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
