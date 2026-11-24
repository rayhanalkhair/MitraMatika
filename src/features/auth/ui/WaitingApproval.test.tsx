// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("@/features/auth/actions/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("@/features/settings/actions/set-locale", () => ({ setLocaleAction: vi.fn() }));

import { WaitingApproval } from "./WaitingApproval";

afterEach(cleanup);

const slot = <button type="button">Hapus akun</button>;

describe("WaitingApproval", () => {
  it("tells a pending account in Indonesian that the admin was told, and shows its email", () => {
    renderWithIntl(<WaitingApproval email="baru@example.test" deleteAccount={slot} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Menunggu persetujuan admin" }),
    ).toBeTruthy();
    expect(screen.getByText("Akun: baru@example.test")).toBeTruthy();
    expect(screen.getByText(/menunggu persetujuan admin\./)).toBeTruthy();
    expect(screen.getByText(/Admin sudah diberi tahu/)).toBeTruthy();
  });

  it("offers a reload link to /home, sign out, the delete slot and the privacy notice", () => {
    renderWithIntl(<WaitingApproval email="baru@example.test" deleteAccount={slot} />);
    expect(screen.getByRole("link", { name: "Cek lagi" }).getAttribute("href")).toBe(
      "/home",
    );
    expect(screen.getByRole("button", { name: "Keluar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus akun" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Pemberitahuan privasi" }).getAttribute("href"),
    ).toBe("/privacy");
  });

  it("has English copy", () => {
    renderWithIntl(<WaitingApproval email="new@example.test" deleteAccount={slot} />, {
      locale: "en",
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Waiting for admin approval" }),
    ).toBeTruthy();
    expect(screen.getByText(/The admin was told/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy notice" })).toBeTruthy();
  });
});
