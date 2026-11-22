import { describe, expect, it, vi } from "vitest";

// The pages only export their title statically; nothing here renders or reaches a database.
vi.mock("@/features/auth/service/guard", () => ({ requireAllowedUser: vi.fn() }));
vi.mock("@/lib/db/runtime", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ runAsUser: vi.fn() }));
vi.mock("@/features/auth/actions/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/features/curriculum", () => ({ getCurriculum: vi.fn() }));

vi.mock("next/font/google", () => ({
  Manrope: () => ({ variable: "" }),
  Plus_Jakarta_Sans: () => ({ variable: "" }),
}));
vi.mock("./providers", () => ({ Providers: vi.fn() }));

import { metadata as rootMetadata } from "./layout";

// What Next hands generateMetadata; pages that read the query see a usable reset token.
const PAGE_PROPS = {
  params: Promise.resolve({}),
  searchParams: Promise.resolve({ token: "token" }),
} as never;

const PAGES: [
  string,
  () => Promise<{ generateMetadata?: (props: never) => Promise<{ title?: unknown }> }>,
  string,
][] = [
  ["Beranda", () => import("./(shell)/home/page"), "Beranda"],
  ["Buat Soal", () => import("./(shell)/generate/page"), "Buat Soal"],
  ["Bank Soal", () => import("./(shell)/question-bank/page"), "Bank Soal"],
  [
    "Permintaan soal",
    () => import("./(shell)/generate/[requestId]/page"),
    "Permintaan soal",
  ],
  ["Selesaikan", () => import("./(shell)/solve/page"), "Selesaikan"],
  ["Materi", () => import("./(shell)/materials/page"), "Materi Pembelajaran"],
  [
    "Penyusun Asesmen",
    () => import("./(shell)/assessment-builder/page"),
    "Penyusun Asesmen",
  ],
  ["Sampah", () => import("./(shell)/trash/page"), "Sampah"],
  ["Pengaturan", () => import("./(shell)/settings/page"), "Pengaturan"],
  ["Bank detail", () => import("./(shell)/question-bank/[id]/page"), "Soal di Bank Soal"],
  ["Lainnya", () => import("./(shell)/more/page"), "Lainnya"],
  ["Masuk", () => import("./(auth)/sign-in/page"), "Masuk"],
  ["Daftar", () => import("./(auth)/sign-up/page"), "Daftar"],
  ["Cek email", () => import("./(auth)/verify-email/page"), "Cek email kamu"],
  ["Lupa kata sandi", () => import("./(auth)/forgot-password/page"), "Lupa kata sandi"],
  [
    "Kata sandi baru",
    () => import("./(auth)/reset-password/page"),
    "Buat kata sandi baru",
  ],
  ["Privasi", () => import("./privacy/page"), "Pemberitahuan privasi"],
];

describe("root title template", () => {
  it("lets every page title follow the active locale", async () => {
    const { setTestLocale } = await import("@/test/intl-server");
    setTestLocale("en");
    try {
      const page = await import("./(shell)/question-bank/page");
      expect((await page.generateMetadata()).title).toBe("Question bank");
      const login = await import("./(auth)/sign-in/page");
      expect((await login.generateMetadata()).title).toBe("Sign in");
    } finally {
      setTestLocale("id");
    }
  }, 30_000);

  it("suffixes child titles with the app name and keeps a plain default", () => {
    expect(rootMetadata.title).toEqual({
      default: "MitraMatika",
      template: "%s – MitraMatika",
    });
  });
});

describe("page titles", () => {
  // The first import of a page pulls in its component tree, which is slow on a loaded machine.
  it.each(PAGES)(
    "%s has its own translated title",
    async (_name, load, title) => {
      const page = await load();
      expect((await page.generateMetadata?.(PAGE_PROPS))?.title).toBe(title);
    },
    30_000,
  );
});
