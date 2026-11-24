// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { SignInState } from "../schema/auth-forms";

const action = vi.hoisted(() => ({
  fn: vi.fn<(previous: SignInState, data: FormData) => Promise<SignInState>>(() =>
    Promise.resolve({}),
  ),
}));
vi.mock("@/features/auth/actions/sign-in", () => ({ signInAction: action.fn }));

import { SignInForm } from "./SignInForm";

beforeEach(() => {
  action.fn.mockReset();
  action.fn.mockResolvedValue({});
});
afterEach(cleanup);

describe("SignInForm", () => {
  it("has an email field, a password field and a link to forgot password", () => {
    renderWithIntl(<SignInForm />);
    const email = screen.getByLabelText<HTMLInputElement>("Email");
    expect(email.type).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    const password = screen.getByLabelText<HTMLInputElement>("Kata sandi");
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(
      screen.getByRole("link", { name: "Lupa kata sandi?" }).getAttribute("href"),
    ).toBe("/forgot-password");
    expect(screen.getByRole("button", { name: "Masuk" })).toBeTruthy();
  });

  it("shows inline errors, focuses the first invalid field and does not submit an empty form", async () => {
    renderWithIntl(<SignInForm />);
    await userEvent.click(screen.getByRole("button", { name: "Masuk" }));
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(email.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Masukkan alamat email yang valid.");
    expect(screen.getByText("Masukkan kata sandi.")).toBeTruthy();
    expect(document.activeElement).toBe(email);
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("submits the address and password", async () => {
    renderWithIntl(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "guru@example.test");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "rahasia123");
    await userEvent.click(screen.getByRole("button", { name: "Masuk" }));
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    const data = action.fn.mock.calls[0][1];
    expect(data.get("email")).toBe("guru@example.test");
    expect(data.get("password")).toBe("rahasia123");
  });

  it("shows a wrong password as one alert and keeps the address", async () => {
    action.fn.mockResolvedValue({
      error: "invalidCredentials",
      values: { email: "guru@example.test" },
    });
    renderWithIntl(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "guru@example.test");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "salah12345");
    await userEvent.click(screen.getByRole("button", { name: "Masuk" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Email atau kata sandi salah.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "guru@example.test",
    );
  });

  it("offers a resend for an unverified address", async () => {
    action.fn.mockResolvedValue({
      error: "emailNotVerified",
      values: { email: "guru@example.test" },
    });
    renderWithIntl(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "guru@example.test");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "rahasia123");
    await userEvent.click(screen.getByRole("button", { name: "Masuk" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Email Anda belum dikonfirmasi.");
    expect(
      screen
        .getByRole("link", { name: "Kirim ulang tautan konfirmasi" })
        .getAttribute("href"),
    ).toBe("/verify-email");
  });

  it("reports a rate limit", async () => {
    action.fn.mockResolvedValue({ error: "rateLimited", values: { email: "a@b.test" } });
    renderWithIntl(<SignInForm />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Kata sandi"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Masuk" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
  });
});
