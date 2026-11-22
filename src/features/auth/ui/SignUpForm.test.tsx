// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { SignUpState } from "../schema/auth-forms";

const action = vi.hoisted(() => ({
  fn: vi.fn<(previous: SignUpState, data: FormData) => Promise<SignUpState>>(() =>
    Promise.resolve({}),
  ),
}));
vi.mock("@/features/auth/actions/sign-up", () => ({ signUpAction: action.fn }));

import { SignUpForm } from "./SignUpForm";

beforeEach(() => {
  action.fn.mockReset();
  action.fn.mockResolvedValue({});
});
afterEach(cleanup);

const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

async function fillValid() {
  await userEvent.type(screen.getByLabelText("Nama lengkap"), "Bu Rina");
  await userEvent.type(screen.getByLabelText("Email"), "rina@example.test");
  await userEvent.type(screen.getByLabelText("Kata sandi"), "rahasia123");
  await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), "rahasia123");
  await userEvent.click(screen.getByRole("checkbox"));
}

describe("SignUpForm", () => {
  it("has every field with its autocomplete, and a privacy checkbox linking to /privacy", () => {
    renderWithIntl(<SignUpForm />);
    expect(screen.getByLabelText("Nama lengkap").getAttribute("autocomplete")).toBe(
      "name",
    );
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("email");
    expect(screen.getByLabelText("Kata sandi").getAttribute("autocomplete")).toBe(
      "new-password",
    );
    expect(screen.getByLabelText("Ulangi kata sandi").getAttribute("autocomplete")).toBe(
      "new-password",
    );
    expect(
      screen.getByLabelText("Nama sekolah (opsional)").getAttribute("autocomplete"),
    ).toBe("organization");
    const checkbox = screen.getByRole("checkbox", {
      name: "Saya sudah membaca dan menyetujui pemberitahuan privasi.",
    });
    expect(checkbox).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "pemberitahuan privasi" }).getAttribute("href"),
    ).toBe("/privacy");
    expect(screen.getByRole("button", { name: "Buat akun" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/belajar\.id|NIP/i);
  });

  it("invalid input shows every field error at once without calling signUpAction", async () => {
    renderWithIntl(<SignUpForm />);
    await userEvent.type(screen.getByLabelText("Nama lengkap"), "R");
    await userEvent.type(screen.getByLabelText("Email"), "bukan-email");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "abcdefgh");
    await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), "lain");
    await userEvent.type(
      screen.getByLabelText("Nama sekolah (opsional)"),
      "x".repeat(121),
    );
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));

    await waitFor(() => {
      expect(describedText(screen.getByLabelText("Nama lengkap"))).toBe(
        "Nama harus 2 sampai 80 karakter.",
      );
    });
    expect(describedText(screen.getByLabelText("Email"))).toBe(
      "Masukkan alamat email yang valid.",
    );
    expect(describedText(screen.getByLabelText("Kata sandi"))).toContain(
      "Kata sandi harus berisi huruf dan angka.",
    );
    expect(describedText(screen.getByLabelText("Ulangi kata sandi"))).toBe(
      "Kedua kata sandi tidak sama.",
    );
    expect(describedText(screen.getByLabelText("Nama sekolah (opsional)"))).toBe(
      "Nama sekolah paling banyak 120 karakter.",
    );
    expect(describedText(screen.getByRole("checkbox"))).toBe(
      "Setujui pemberitahuan privasi untuk mendaftar.",
    );
    for (const label of ["Nama lengkap", "Email", "Kata sandi", "Ulangi kata sandi"]) {
      expect(screen.getByLabelText(label).getAttribute("aria-invalid"), label).toBe(
        "true",
      );
    }
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("focuses name first, then the first invalid field", async () => {
    renderWithIntl(<SignUpForm />);
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Nama lengkap"));
    });

    await userEvent.type(screen.getByLabelText("Nama lengkap"), "Bu Rina");
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Email"));
    });
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("the privacy row keeps the 44 px label target and its error is described by", async () => {
    renderWithIntl(<SignUpForm />);
    const checkbox = screen.getByRole("checkbox");
    const target = checkbox.closest("label");
    expect(target?.getAttribute("data-slot")).toBe("privacy-target");
    expect(target?.className).toContain("min-h-11");

    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    await waitFor(() => {
      expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    });
    expect(checkbox.getAttribute("aria-describedby")).toBe("sign-up-privacy-error");
    expect(describedText(checkbox)).toBe(
      "Setujui pemberitahuan privasi untuk mendaftar.",
    );

    await userEvent.click(checkbox);
    await waitFor(() => {
      expect(checkbox.getAttribute("aria-invalid")).toBeNull();
    });
    expect(checkbox.getAttribute("aria-describedby")).toBeNull();
  });

  it("describes the password policy next to the password", () => {
    renderWithIntl(<SignUpForm />);
    expect(describedText(screen.getByLabelText("Kata sandi"))).toBe(
      "8 sampai 128 karakter, berisi huruf dan angka.",
    );
  });

  it("submits a valid sign-up with the checkbox", async () => {
    renderWithIntl(<SignUpForm />);
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    const data = action.fn.mock.calls[0][1];
    expect(data.get("name")).toBe("Bu Rina");
    expect(data.get("acceptPrivacy")).toBe("on");
  });

  it("rate limited from the server shows formErrors.rateLimited and keeps name, email and school", async () => {
    action.fn.mockResolvedValue({
      error: "rateLimited",
      values: {
        name: "Bu Rina",
        email: "rina@example.test",
        schoolName: "SMP 1",
        acceptPrivacy: "on",
      },
    });
    renderWithIntl(<SignUpForm />);
    await fillValid();
    await userEvent.type(screen.getByLabelText("Nama sekolah (opsional)"), "SMP 1");
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Nama lengkap").value).toBe("Bu Rina");
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "rina@example.test",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Nama sekolah (opsional)").value).toBe(
      "SMP 1",
    );
    expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
  });

  it("valid in the browser, refused by the server: shows its field error, keeps the values and focuses that field", async () => {
    action.fn.mockResolvedValue({
      fieldErrors: { email: "emailInvalid" },
      values: { name: "Bu Rina", email: "rina@example.test", acceptPrivacy: "on" },
    });
    renderWithIntl(<SignUpForm />);
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));

    const email = screen.getByLabelText<HTMLInputElement>("Email");
    await waitFor(() => {
      expect(email.getAttribute("aria-invalid")).toBe("true");
    });
    expect(describedText(email)).toBe("Masukkan alamat email yang valid.");
    await waitFor(() => {
      expect(document.activeElement).toBe(email);
    });
    expect(email.value).toBe("rina@example.test");
    expect(screen.getByLabelText<HTMLInputElement>("Nama lengkap").value).toBe("Bu Rina");
  });

  it("pending shows the working label and aria-busy", async () => {
    let finish: (state: SignUpState) => void = () => undefined;
    action.fn.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderWithIntl(<SignUpForm />);
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));

    const button = await screen.findByRole("button", { name: "Memproses…" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      finish({});
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Buat akun" });
  });

  it("a password changed to match the confirmation clears the mismatch after a failed submit", async () => {
    renderWithIntl(<SignUpForm />);
    const password = screen.getByLabelText("Kata sandi");
    const confirm = screen.getByLabelText("Ulangi kata sandi");
    await userEvent.type(password, "rahasia123");
    await userEvent.type(confirm, "rahasia12");
    await userEvent.click(screen.getByRole("button", { name: "Buat akun" }));
    await waitFor(() => {
      expect(describedText(confirm)).toBe("Kedua kata sandi tidak sama.");
    });

    await userEvent.type(password, "{Backspace}");
    await waitFor(() => {
      expect(confirm.getAttribute("aria-invalid")).toBeNull();
    });
    expect(describedText(confirm)).toBe("");

    // And back: a password that no longer matches marks the confirmation again.
    await userEvent.type(password, "9");
    await waitFor(() => {
      expect(describedText(confirm)).toBe("Kedua kata sandi tidak sama.");
    });
  });

  it("shows no mismatch before the first submit", async () => {
    renderWithIntl(<SignUpForm />);
    const confirm = screen.getByLabelText("Ulangi kata sandi");
    await userEvent.type(confirm, "rahasia12");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "rahasia123");
    await userEvent.tab();
    expect(confirm.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Kedua kata sandi tidak sama.")).toBeNull();
  });
});
