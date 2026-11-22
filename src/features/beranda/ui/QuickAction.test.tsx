// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { QuickAction } from "./QuickAction";

afterEach(cleanup);

describe("QuickAction", () => {
  it("links to the generator with the regular label and no hint", () => {
    renderWithIntl(<QuickAction first={false} />);
    const link = screen.getByRole("link", { name: "Buat soal" });
    expect(link.getAttribute("href")).toBe("/generate");
    expect(link.className).toContain("min-h-11");
    expect(screen.queryByText(/Pilih topik/)).toBeNull();
  });

  it("shows the first-use headline and hint", () => {
    renderWithIntl(<QuickAction first />);
    expect(
      screen.getByRole("link", { name: "Buat soal pertama" }).getAttribute("href"),
    ).toBe("/generate");
    expect(
      screen.getByText("Pilih topik, lalu AI menyiapkan soal untuk Anda tinjau."),
    ).toBeTruthy();
  });
});
