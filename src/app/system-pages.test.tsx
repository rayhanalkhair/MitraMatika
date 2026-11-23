// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { renderWithIntl } from "@/test/intl";
import idMessages from "../../messages/id.json";
import enMessages from "../../messages/en.json";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "systemPages.notFound") =>
    Promise.resolve(createTranslator({ locale: "id", messages: idMessages, namespace })),
}));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));

import RootNotFound, { generateMetadata } from "./not-found";
import ShellNotFound from "./(shell)/not-found";
import RootError from "./error";
import ShellError from "./(shell)/error";
import GlobalError from "./global-error";

afterEach(cleanup);

describe("the 404 page", () => {
  it("is Indonesian, has one h1 and a link back to the home page, and names nobody", () => {
    renderWithIntl(<RootNotFound />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Halaman tidak ditemukan" }),
    ).toBeTruthy();
    const home = screen.getByRole("link", { name: "Kembali ke Beranda" });
    // /home sends a signed-out visitor to the sign-in page and a pending account to the waiting
    // page, so one link serves every state and the 404 reads no session at all.
    expect(home.getAttribute("href")).toBe("/home");
    expect(document.body.textContent).not.toMatch(/@|session|sesi/i);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("has a page title of its own and an English copy", async () => {
    expect(await generateMetadata()).toEqual({ title: "Halaman tidak ditemukan" });
    cleanup();
    renderWithIntl(<RootNotFound />, { locale: "en" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Home" }).getAttribute("href")).toBe(
      "/home",
    );
  });

  it("keeps the app frame inside the signed-in area: no second main landmark", () => {
    renderWithIntl(<ShellNotFound />);
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Halaman tidak ditemukan" }),
    ).toBeTruthy();
    cleanup();
    renderWithIntl(<RootNotFound />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});

describe("the error pages", () => {
  const error = new Error("select * from secret_table failed for pak@example.test");

  it("offers a retry and a way home, and shows nothing of the error", async () => {
    const retry = vi.fn();
    for (const Page of [RootError, ShellError]) {
      renderWithIntl(<Page error={error} retry={retry} reset={vi.fn()} />);
      expect(
        screen.getByRole("heading", { level: 1, name: "Terjadi kesalahan" }),
      ).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/select|secret|pak@/);
      expect(
        screen.getByRole("link", { name: "Kembali ke Beranda" }).getAttribute("href"),
      ).toBe("/home");
      await userEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
      cleanup();
    }
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("is available in English", () => {
    renderWithIntl(<RootError error={error} retry={vi.fn()} reset={vi.fn()} />, {
      locale: "en",
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("the global boundary renders its own document with a retry, in Indonesian", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={error} retry={vi.fn()} reset={vi.fn()} />,
    );
    expect(html).toContain('<html lang="id"');
    expect(html).toContain("Terjadi kesalahan");
    expect(html).toContain("Coba lagi");
    expect(html).not.toContain("secret_table");
  });
});

describe("no loading state in the signed-in group", () => {
  it("has no loading.tsx above pages that call notFound(): a streamed page would answer 404 as 200", () => {
    // loading.md, "Status codes": streaming responses start with 200. Pages under (shell) such as
    // question-bank/[id] and materials/[id] call notFound(); e2e specs expect a real 404.
    expect(existsSync(join(process.cwd(), "src/app/(shell)/loading.tsx"))).toBe(false);
  });

  it("only allows a loading.tsx in a segment whose pages never call notFound()", () => {
    const root = join(process.cwd(), "src/app");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const files = walk(root);
    const loadings = files.filter((file) => /[\/]loading\.tsx$/.test(file));
    for (const loading of loadings) {
      const segment = loading.replace(/[\/]loading\.tsx$/, "");
      const callers = files.filter(
        (file) =>
          file.startsWith(segment) &&
          /\.tsx?$/.test(file) &&
          !file.includes(".test.") &&
          readFileSync(file, "utf-8").includes("notFound()"),
      );
      expect(callers, loading).toEqual([]);
    }
  });
});

describe("the catalogs", () => {
  it("have the same system page messages in both languages", () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string"
          ? [key]
          : keys(child as object).map((sub) => `${key}.${sub}`),
      );
    expect(keys(enMessages.systemPages).sort()).toEqual(
      keys(idMessages.systemPages).sort(),
    );
  });
});
