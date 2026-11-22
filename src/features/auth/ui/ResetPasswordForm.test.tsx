// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { ResetPasswordState } from "../schema/auth-forms";

const action = vi.hoisted(() => ({
  fn: vi.fn<
    (previous: ResetPasswordState, data: FormData) => Promise<ResetPasswordState>
  >(() => Promise.resolve({})),
}));
vi.mock("@/features/auth/actions/reset-password", () => ({
  resetPasswordAction: action.fn,
}));

import { ResetPasswordForm } from "./ResetPasswordForm";

beforeEach(() => {
  action.fn.mockReset();
  action.fn.mockResolvedValue({});
});
afterEach(cleanup);

describe("ResetPasswordForm", () => {
  it("asks for the new password twice, as new passwords", () => {
    renderWithIntl(<ResetPasswordForm token="tok" />);
    for (const label of ["Kata sandi baru", "Ulangi kata sandi"]) {
      expect(screen.getByLabelText(label).getAttribute("autocomplete"), label).toBe(
        "new-password",
      );
    }
  });

  it("checks the policy and the confirmation before submitting", async () => {
    renderWithIntl(<ResetPasswordForm token="tok" />);
    await userEvent.type(screen.getByLabelText("Kata sandi baru"), "pendek1");
    await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), "lain");
    await userEvent.click(screen.getByRole("button", { name: "Simpan kata sandi" }));
    expect(screen.getByText("Kata sandi minimal 8 karakter.")).toBeTruthy();
    expect(screen.getByText("Kedua kata sandi tidak sama.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Kata sandi baru"));
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("sends the token with the new password", async () => {
    renderWithIntl(<ResetPasswordForm token="tok-123" />);
    await userEvent.type(screen.getByLabelText("Kata sandi baru"), "baru12345");
    await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), "baru12345");
    await userEvent.click(screen.getByRole("button", { name: "Simpan kata sandi" }));
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    const data = action.fn.mock.calls[0][1];
    expect(data.get("token")).toBe("tok-123");
    expect(data.get("password")).toBe("baru12345");
  });

  it("an expired token shows the expired message and a link to request a new one", async () => {
    action.fn.mockResolvedValue({ expired: true });
    renderWithIntl(<ResetPasswordForm token="tok" />);
    await userEvent.type(screen.getByLabelText("Kata sandi baru"), "baru12345");
    await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), "baru12345");
    await userEvent.click(screen.getByRole("button", { name: "Simpan kata sandi" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Tautan ini sudah kedaluwarsa atau pernah dipakai.",
    );
    expect(
      screen.getByRole("link", { name: "Minta tautan baru" }).getAttribute("href"),
    ).toBe("/forgot-password");
    expect(screen.queryByLabelText("Kata sandi baru")).toBeNull();
  });
});
