// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { ChangePasswordState } from "@/features/auth";

const action = vi.hoisted(() => ({
  fn: vi.fn<
    (previous: ChangePasswordState, data: FormData) => Promise<ChangePasswordState>
  >(() => Promise.resolve({})),
}));
vi.mock("@/features/settings/actions/change-password", () => ({
  changePasswordAction: action.fn,
}));

import { ChangePasswordForm } from "./ChangePasswordForm";

beforeEach(() => {
  action.fn.mockReset();
  action.fn.mockResolvedValue({});
});
afterEach(cleanup);

async function fill(current: string, next: string, confirm = next) {
  await userEvent.type(screen.getByLabelText("Kata sandi saat ini"), current);
  await userEvent.type(screen.getByLabelText("Kata sandi baru"), next);
  await userEvent.type(screen.getByLabelText("Ulangi kata sandi"), confirm);
  await userEvent.click(screen.getByRole("button", { name: "Ganti kata sandi" }));
}

describe("ChangePasswordForm", () => {
  it("asks for the current password and the new one twice, with the right autocomplete", () => {
    renderWithIntl(<ChangePasswordForm />);
    expect(
      screen.getByLabelText("Kata sandi saat ini").getAttribute("autocomplete"),
    ).toBe("current-password");
    for (const label of ["Kata sandi baru", "Ulangi kata sandi"]) {
      expect(screen.getByLabelText(label).getAttribute("autocomplete"), label).toBe(
        "new-password",
      );
    }
    // The policy hint is tied to the new password.
    expect(
      screen.getByLabelText("Kata sandi baru").getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "Ganti kata sandi" }),
    ).toBeTruthy();
  });

  it("sends the three fields", async () => {
    renderWithIntl(<ChangePasswordForm />);
    await fill("lama12345", "baru12345");
    await waitFor(() => {
      expect(action.fn).toHaveBeenCalledTimes(1);
    });
    const data = action.fn.mock.calls[0][1];
    expect([
      data.get("currentPassword"),
      data.get("newPassword"),
      data.get("confirmPassword"),
    ]).toEqual(["lama12345", "baru12345", "baru12345"]);
  });

  it("shows a wrong current password on that field and focuses it", async () => {
    action.fn.mockResolvedValue({ fieldErrors: { currentPassword: "wrongPassword" } });
    renderWithIntl(<ChangePasswordForm />);
    await fill("salah12345", "baru12345");
    const error = await screen.findByText("Kata sandi saat ini salah.");
    const current = screen.getByLabelText("Kata sandi saat ini");
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(current.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(current);
  });

  it("confirms the change and that other devices were signed out", async () => {
    action.fn.mockResolvedValue({ savedAt: 1 });
    renderWithIntl(<ChangePasswordForm />);
    await fill("lama12345", "baru12345");
    const saved = await screen.findByText(
      "Kata sandi sudah diganti. Perangkat lain sudah dikeluarkan.",
    );
    expect(saved.getAttribute("role")).toBe("status");
  });

  it("shows the rate limit as a form error", async () => {
    action.fn.mockResolvedValue({ error: "rateLimited" });
    renderWithIntl(<ChangePasswordForm />);
    await fill("lama12345", "baru12345");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Terlalu banyak percobaan.",
    );
  });
});
