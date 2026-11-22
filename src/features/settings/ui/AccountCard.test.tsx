// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { ProfileFormState } from "@/features/auth";

const actions = vi.hoisted(() => ({
  updateProfile: vi.fn<
    (previous: ProfileFormState, data: FormData) => Promise<ProfileFormState>
  >(() => Promise.resolve({})),
}));
vi.mock("@/features/settings/actions/update-profile", () => ({
  updateProfileAction: actions.updateProfile,
}));
vi.mock("@/features/settings/actions/change-password", () => ({
  changePasswordAction: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@/features/settings/actions/delete-account", () => ({
  deleteAccountAction: vi.fn(() => Promise.resolve({})),
}));

import { AccountCard } from "./AccountCard";

const ACCOUNT = {
  name: "Bu Sari",
  email: "sari@example.test",
  schoolName: "SMP Negeri 2 Bogor",
  hasPassword: true,
};

beforeEach(() => {
  actions.updateProfile.mockReset();
  actions.updateProfile.mockResolvedValue({});
});
afterEach(cleanup);

describe("AccountCard: profile", () => {
  it("shows the account email and the current name and school in a labelled form", () => {
    renderWithIntl(<AccountCard account={ACCOUNT} />);
    expect(screen.getByRole("heading", { level: 2, name: "Akun" })).toBeTruthy();
    expect(screen.getByText("sari@example.test")).toBeTruthy();
    const name = screen.getByLabelText<HTMLInputElement>("Nama lengkap");
    expect(name.value).toBe("Bu Sari");
    expect(name.getAttribute("autocomplete")).toBe("name");
    const school = screen.getByLabelText<HTMLInputElement>("Nama sekolah (opsional)");
    expect(school.value).toBe("SMP Negeri 2 Bogor");
  });

  it("sends the typed name and school and confirms the save", async () => {
    actions.updateProfile.mockResolvedValue({
      savedAt: 1,
      values: { name: "Bu Sari W", schoolName: "SMP 2" },
    });
    renderWithIntl(<AccountCard account={ACCOUNT} />);
    const name = screen.getByLabelText("Nama lengkap");
    await userEvent.clear(name);
    await userEvent.type(name, "Bu Sari W");
    await userEvent.click(screen.getByRole("button", { name: "Simpan profil" }));
    await waitFor(() => {
      expect(actions.updateProfile).toHaveBeenCalledTimes(1);
    });
    expect(actions.updateProfile.mock.calls[0][1].get("name")).toBe("Bu Sari W");
    const saved = await screen.findByText("Profil sudah disimpan.");
    expect(saved.getAttribute("role")).toBe("status");
  });

  it("shows the server's field errors tied to their inputs and focuses the first", async () => {
    actions.updateProfile.mockResolvedValue({
      fieldErrors: { name: "nameLength" },
      values: { name: " ", schoolName: "" },
    });
    renderWithIntl(<AccountCard account={ACCOUNT} />);
    await userEvent.click(screen.getByRole("button", { name: "Simpan profil" }));
    const error = await screen.findByText("Nama harus 2 sampai 80 karakter.");
    const name = screen.getByLabelText("Nama lengkap");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(name);
  });
});

describe("AccountCard: password", () => {
  it("offers the password change to a user with a password", () => {
    renderWithIntl(<AccountCard account={ACCOUNT} />);
    expect(
      screen.getByRole("heading", { level: 3, name: "Ganti kata sandi" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Kata sandi saat ini")).toBeTruthy();
  });

  it("change password is hidden for users without a credential account", () => {
    renderWithIntl(<AccountCard account={{ ...ACCOUNT, hasPassword: false }} />);
    expect(screen.queryByRole("heading", { name: "Ganti kata sandi" })).toBeNull();
    expect(screen.queryByLabelText("Kata sandi saat ini")).toBeNull();
    // No "set a password" either: Google-only users use the reset flow.
    expect(document.body.textContent).not.toMatch(/atur kata sandi|buat kata sandi/i);
  });
});

describe("AccountCard: delete", () => {
  it.each([true, false])("offers account deletion (hasPassword %s)", (hasPassword) => {
    renderWithIntl(<AccountCard account={{ ...ACCOUNT, hasPassword }} />);
    expect(screen.getByRole("heading", { level: 3, name: "Hapus akun" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus akun" })).toBeTruthy();
  });
});
