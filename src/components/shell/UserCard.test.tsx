// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("@/features/auth/ui/SignOutButton", () => ({
  SignOutButton: () => <button>Keluar</button>,
}));

import { UserCard } from "./UserCard";

afterEach(cleanup);

describe("UserCard", () => {
  it("shows initials, the display name, the email and the sign-out button", () => {
    renderWithIntl(<UserCard name="Siti Rahma" email="siti@example.test" />);
    expect(screen.getByText("SR")).toBeTruthy();
    expect(screen.getByText("Siti Rahma")).toBeTruthy();
    expect(screen.getByText("siti@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keluar" })).toBeTruthy();
  });

  it("falls back to the email local part when the name is null", () => {
    renderWithIntl(<UserCard name={null} email="guru.matika@example.test" />);
    expect(screen.getByText("guru.matika")).toBeTruthy();
    expect(screen.getByText("GM")).toBeTruthy();
  });

  it("truncates long names and emails on one line", () => {
    renderWithIntl(
      <UserCard
        name="Nama Yang Sangat Panjang Sekali"
        email="a.very.long@example.test"
      />,
    );
    expect(screen.getByText("Nama Yang Sangat Panjang Sekali").className).toContain(
      "truncate",
    );
    expect(screen.getByText("a.very.long@example.test").className).toContain("truncate");
  });
});
