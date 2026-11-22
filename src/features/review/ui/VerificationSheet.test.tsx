// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import userEvent from "@testing-library/user-event";
import { VerificationSheet } from "./VerificationSheet";

afterEach(cleanup);

const verification = {
  status: "ketidaksesuaian" as const,
  checked: true,
  checks: [
    {
      type: "numeric_eval" as const,
      status: "fail" as const,
      detail: "1+1 = 2, bukan 99",
    },
    { type: "other" as const, status: "unsupported" as const, detail: "tidak didukung" },
  ],
  crossCheck: "disagree" as const,
  regenerated: true,
  regenerationFailed: false,
};

describe("VerificationSheet", () => {
  it("opens, shows the checks and the disclaimer, and closes with Escape returning focus", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={2}
        verification={verification}
        status="ketidaksesuaian"
      />,
    );
    const button = screen.getByRole("button", { name: /Lihat detail pemeriksaan/ });
    expect(button.className).toMatch(/min-h-11/);

    await user.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Ditemukan ketidaksesuaian");
    expect(dialog.textContent).toContain("Hitungan");
    expect(dialog.textContent).toContain("Tidak lulus");
    expect(dialog.textContent).toContain("1+1 = 2, bukan 99");
    expect(dialog.textContent).toContain("Pemeriksaan lain");
    expect(dialog.textContent).toContain("berbeda");
    expect(dialog.textContent).toContain("dibuat ulang satu kali");
    expect(dialog.textContent).toContain(
      "Pemeriksaan otomatis tidak menjamin kebenaran.",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes with the Tutup button and returns focus", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={1}
        verification={verification}
        status="ketidaksesuaian"
      />,
    );
    const button = screen.getByRole("button", { name: /Lihat detail pemeriksaan/ });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Tutup" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("shows the note when the automatic regeneration failed", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={1}
        verification={{ ...verification, regenerated: false, regenerationFailed: true }}
        status="ketidaksesuaian"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Lihat detail pemeriksaan/ }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Pembuatan ulang otomatis tidak berhasil",
    );
  });

  it("keeps a check detail with HTML or math literal", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={1}
        verification={{
          ...verification,
          checks: [{ type: "other", status: "fail", detail: "<b>x</b> dan $x$" }],
        }}
        status="ketidaksesuaian"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Lihat detail pemeriksaan/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("<b>x</b> dan $x$");
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.querySelector(".katex")).toBeNull();
  });

  it("explains a question that is still waiting for the AI service", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={1}
        verification={{ ...verification, checked: false, checks: [], crossCheck: null }}
        status="waiting"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Lihat detail pemeriksaan/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Menunggu pemeriksaan");
    expect(screen.getByRole("dialog").textContent).toContain("ditunda");
  });

  it("explains a question that is still being checked", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <VerificationSheet
        questionNumber={1}
        verification={{
          ...verification,
          checked: false,
          checks: [],
          crossCheck: null,
          regenerated: false,
          status: "belum_dapat_diverifikasi",
        }}
        status="checking"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Lihat detail pemeriksaan/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Sedang diperiksa");
    expect(screen.getByRole("dialog").textContent).toContain(
      "Pemeriksaan otomatis tidak menjamin kebenaran.",
    );
  });
});
