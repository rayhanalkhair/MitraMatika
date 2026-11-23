// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { renderWithIntl } from "@/test/intl";
import enMessages from "../../../messages/en.json";
import idMessages from "../../../messages/id.json";

const locale = vi.hoisted(() => {
  const state: { current: "id" | "en" } = { current: "id" };
  return state;
});

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "privacy") =>
    Promise.resolve(
      createTranslator({
        locale: locale.current,
        messages: locale.current === "id" ? idMessages : enMessages,
        namespace,
      }),
    ),
}));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));

import PrivacyPage from "./page";

afterEach(() => {
  cleanup();
  locale.current = "id";
});

describe("privacy page", () => {
  it("explains storage, the AI providers, student data, deletion and contact in Indonesian", async () => {
    renderWithIntl(await PrivacyPage());
    expect(
      screen.getByRole("heading", { level: 1, name: "Pemberitahuan privasi" }),
    ).toBeTruthy();
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(sections).toEqual([
      "Data yang kami simpan",
      "Layanan AI dan data yang dikirim",
      "Tanpa data siswa",
      "Menghapus akun",
    ]);
    const text = document.body.textContent;
    expect(text).toContain("Groq");
    expect(text).toContain("Gemini");
    expect(text).toContain("Pengaturan");
    // What a deletion leaves behind is stated, not "all your data are deleted" (final review I4).
    expect(text).not.toContain("semua data milikmu ikut terhapus");
    expect(text).toContain("paling lama 8 minggu");
    expect(text).toContain("catatan bahwa sebuah akun telah dihapus");
    // The deletion record keeps an HMAC of the account id (ruling S12): said, not denied.
    expect(text).toContain("bentuk acak satu arah dari ID akun");
    expect(text).not.toContain("tanpa nama, email, atau ID akun");
    expect(text).toContain("alamat IP dan browser");
    // The owner is emailed each new account's name, email and school (through Resend), and an
    // account that is never approved is kept until its user deletes it (security review F4).
    expect(text).toContain("email kepada pemilik MitraMatika");
    expect(text).toContain("namamu, alamat emailmu, dan nama sekolahmu");
    expect(text).toContain("belum disetujui pemilik tetap disimpan");
    // No contact channel exists, so the notice promises none (ruling S10).
    expect(text).not.toMatch(/hubungi|kontak/i);
    expect(screen.getByRole("group", { name: "Bahasa tampilan" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Kembali ke halaman masuk" }).getAttribute("href"),
    ).toBe("/sign-in");
  });

  it("is available in English", async () => {
    locale.current = "en";
    renderWithIntl(await PrivacyPage(), { locale: "en" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy notice" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "No student data" }),
    ).toBeTruthy();
    const text = document.body.textContent;
    expect(text).not.toContain("all your data are deleted");
    expect(text).toContain("for up to 8 weeks");
    expect(text).toContain("a record that an account was deleted");
    expect(text).toContain("a one-way scrambled form of the account ID");
    expect(text).not.toContain("no name, email or account ID");
    expect(text).toContain("IP address and browser");
    expect(text).toContain("email to the MitraMatika owner");
    expect(text).toContain("your name, your email address and your school name");
    expect(text).toContain("has not approved is still kept");
  });
});
