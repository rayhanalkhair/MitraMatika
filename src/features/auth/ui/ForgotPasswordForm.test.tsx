// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { EmailFormState } from "../schema/auth-forms";

const action = vi.hoisted(() => ({
  fn: vi.fn<(previous: EmailFormState, data: FormData) => Promise<EmailFormState>>(() =>
    Promise.resolve({ sentAt: 1 }),
  ),
}));
vi.mock("@/features/auth/actions/forgot-password", () => ({
  requestPasswordResetAction: action.fn,
}));

import { ForgotPasswordForm } from "./ForgotPasswordForm";

beforeEach(() => {
  action.fn.mockReset();
  action.fn.mockResolvedValue({ sentAt: 1 });
});
afterEach(cleanup);

const CONFIRMATION =
  "Jika ada akun dengan email itu, kami sudah mengirim tautan untuk membuat kata sandi baru. Tautan berlaku 1 jam. Periksa juga folder spam.";

async function submit(email: string) {
  renderWithIntl(<ForgotPasswordForm />);
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.click(screen.getByRole("button", { name: "Kirim tautan" }));
}

describe("ForgotPasswordForm", () => {
  it.each(["ada@example.test", "tidak-ada@example.test"])(
    "forgot password always shows the same confirmation (%s)",
    async (email) => {
      await submit(email);
      const status = await screen.findByRole("status");
      expect(status.textContent).toBe(CONFIRMATION);
      // The form is replaced, and the confirmation takes the focus.
      expect(screen.queryByRole("button", { name: "Kirim tautan" })).toBeNull();
      expect(document.activeElement).toBe(status);
      expect(document.body.textContent).not.toContain(email);
      cleanup();
    },
  );

  it("asks for a valid address first", async () => {
    await submit("x@");
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(email);
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("reports a rate limit and keeps the form", async () => {
    action.fn.mockResolvedValue({ error: "rateLimited", values: { email: "a@b.test" } });
    await submit("a@b.test");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("a@b.test");
  });
});
