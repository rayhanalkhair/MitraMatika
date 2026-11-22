// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { TopBar } from "./TopBar";

afterEach(cleanup);

describe("TopBar", () => {
  it("shows the curriculum context text and the user's initials, with no status pill", () => {
    renderWithIntl(<TopBar user={{ name: "Siti Rahma", email: "siti@example.test" }} />);
    expect(screen.getByText("Kurikulum Merdeka")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Akun Siti Rahma" }).textContent).toBe("SR");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides the context text on mobile and shows a compact logo row there", () => {
    renderWithIntl(<TopBar user={{ name: null, email: "guru@example.test" }} />);
    expect(screen.getByText("Kurikulum Merdeka").className).toContain("hidden");
    expect(screen.getByText("MitraMatika").className).toContain("md:hidden");
    expect(screen.getByRole("img", { name: "Akun guru" }).textContent).toBe("G");
  });
});
