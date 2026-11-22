// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { RESEND_COOLDOWN_SECONDS, type EmailFormState } from "../schema/auth-forms";

const action = vi.hoisted(() => ({
  fn: vi.fn<(previous: EmailFormState, data: FormData) => Promise<EmailFormState>>(() =>
    Promise.resolve({}),
  ),
}));
vi.mock("@/features/auth/actions/verify-email", () => ({
  resendVerificationAction: action.fn,
}));

import { VerifyEmailNotice } from "./VerifyEmailNotice";

beforeEach(() => {
  vi.useFakeTimers();
  action.fn.mockReset();
  action.fn.mockResolvedValue({ sentAt: 1, values: { email: "rina@example.test" } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const resendButton = () => screen.getByRole<HTMLButtonElement>("button");

async function advance(seconds: number) {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

describe("VerifyEmailNotice", () => {
  it("after sign-up the user sees the resend disabled for 60 s with a countdown", async () => {
    expect(RESEND_COOLDOWN_SECONDS).toBe(60);
    renderWithIntl(
      <VerifyEmailNotice defaultEmail="rina@example.test" initialCooldown={60} />,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "rina@example.test",
    );
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toBe("Kirim ulang dalam 60 detik");

    await advance(1);
    expect(resendButton().textContent).toBe("Kirim ulang dalam 59 detik");

    await advance(59);
    expect(resendButton().disabled).toBe(false);
    expect(resendButton().textContent).toBe("Kirim ulang tautan");
  });

  it("a resend shows the same status for every address and starts the countdown again", async () => {
    renderWithIntl(
      <VerifyEmailNotice defaultEmail="rina@example.test" initialCooldown={0} />,
    );
    expect(resendButton().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");

    await act(async () => {
      fireEvent.submit(resendButton().closest("form")!);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(action.fn).toHaveBeenCalledTimes(1);
    expect(action.fn.mock.calls[0][1].get("email")).toBe("rina@example.test");
    expect(screen.getByRole("status").textContent).toBe(
      "Jika alamat itu menunggu konfirmasi, tautan baru sudah dikirim.",
    );
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toBe("Kirim ulang dalam 60 detik");
  });

  it("asks for a valid address before sending", async () => {
    renderWithIntl(<VerifyEmailNotice defaultEmail="" initialCooldown={0} />);
    await act(async () => {
      fireEvent.submit(resendButton().closest("form")!);
      await vi.advanceTimersByTimeAsync(0);
    });
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(email);
    expect(action.fn).not.toHaveBeenCalled();
  });

  it("reports a rate limit and leaves the button usable", async () => {
    action.fn.mockResolvedValue({ error: "rateLimited", values: { email: "a@b.test" } });
    renderWithIntl(<VerifyEmailNotice defaultEmail="a@b.test" initialCooldown={0} />);
    await act(async () => {
      fireEvent.submit(resendButton().closest("form")!);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
    expect(resendButton().disabled).toBe(false);
  });
});
