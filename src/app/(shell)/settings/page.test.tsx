// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  requireAllowedUser: vi.fn(),
  loadAccountSettings: vi.fn(),
  runAsUser: vi.fn(),
  listTemplates: vi.fn(),
}));

vi.mock("@/features/auth", () => ({
  requireAllowedUser: mocks.requireAllowedUser,
  loadAccountSettings: mocks.loadAccountSettings,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/db/client", () => ({ runAsUser: mocks.runAsUser }));
vi.mock("@/features/templates/service/templates", async () => ({
  ...(await vi.importActual<object>("@/features/templates/service/templates")),
  listTemplates: mocks.listTemplates,
}));
vi.mock("@/features/templates/actions/save-template", () => ({
  saveTemplateAction: vi.fn(),
}));
vi.mock("@/features/templates/actions/set-default-template", () => ({
  setDefaultTemplateAction: vi.fn(),
}));
vi.mock("@/features/templates/actions/upload-logo", () => ({
  uploadLogoAction: vi.fn(),
}));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));
vi.mock("@/features/settings/actions/update-profile", () => ({
  updateProfileAction: vi.fn(),
}));

import { logger } from "@/lib/logger";
import SettingsPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAllowedUser.mockResolvedValue({
    status: "allowed",
    userId: "user-1",
    email: "sari@example.test",
    displayName: "Bu Sari",
  });
  mocks.runAsUser.mockImplementation((_db, _user, fn: (tx: unknown) => unknown) =>
    fn({ tx: true }),
  );
  mocks.listTemplates.mockResolvedValue([]);
  mocks.loadAccountSettings.mockResolvedValue({
    name: "Bu Sari",
    email: "sari@example.test",
    schoolName: null,
    hasPassword: false,
  });
});
afterEach(cleanup);

describe("Settings", () => {
  it("shows the account, document template and language cards, and no verification section", async () => {
    const { container } = renderWithIntl(await SettingsPage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Akun", "Templat dokumen", "Bahasa"]);
    expect(container.textContent).not.toMatch(/verifikasi/i);
    // The narrow container keeps the form-width frame.
    expect(container.firstElementChild?.className).toContain("max-w-3xl");
  });

  it("reads the account and templates of the signed-in user only", async () => {
    await SettingsPage();
    expect(mocks.requireAllowedUser).toHaveBeenCalledTimes(1);
    expect(mocks.loadAccountSettings).toHaveBeenCalledWith("user-1");
    // The templates are read under RLS as the same user.
    expect(mocks.runAsUser).toHaveBeenCalledWith(
      { db: true },
      "user-1",
      expect.any(Function),
    );
    expect(mocks.listTemplates).toHaveBeenCalledWith({ tx: true }, "user-1");
  });

  it("says the account could not be loaded, without a form, when reading it fails", async () => {
    mocks.loadAccountSettings.mockResolvedValue(null);
    renderWithIntl(await SettingsPage());
    expect(screen.getByRole("heading", { level: 2, name: "Akun" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Data akun tidak bisa dimuat.",
    );
    expect(screen.queryByLabelText("Nama lengkap")).toBeNull();
  });

  it("keeps the page when the templates cannot be read, with a notice and no template form", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.listTemplates.mockRejectedValue(new Error("relation does not exist"));
    renderWithIntl(await SettingsPage());
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Akun", "Templat dokumen", "Bahasa"]);
    expect(screen.getByRole("alert").textContent).toBe(
      "Templat dokumen tidak bisa dimuat. Muat ulang halaman ini untuk mencoba lagi.",
    );
    expect(screen.queryByLabelText("Nama templat")).toBeNull();
    // The error name only: a database message can carry the SQL parameters.
    expect(logged).toHaveBeenCalledWith(
      { module: "templates", err: { name: "Error", code: null } },
      "templates: could not list the templates",
    );
    logged.mockRestore();
  });
});
