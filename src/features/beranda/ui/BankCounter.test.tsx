// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { BankCounter } from "./BankCounter";

afterEach(cleanup);

describe("BankCounter", () => {
  it("shows the count and a 44 px link to the bank", () => {
    renderWithIntl(<BankCounter count={4} />);
    expect(screen.getByText("Soal di Bank Soal")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Buka Bank Soal" });
    expect(link.getAttribute("href")).toBe("/question-bank");
    expect(link.className).toContain("min-h-11");
  });

  it("shows the count without a link at zero", () => {
    renderWithIntl(<BankCounter count={0} />);
    expect(screen.getByText("Soal di Bank Soal")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
