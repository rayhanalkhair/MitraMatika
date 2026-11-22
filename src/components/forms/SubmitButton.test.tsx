// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SubmitButton } from "./SubmitButton";

afterEach(cleanup);

describe("SubmitButton", () => {
  it("is an enabled submit button with its label while idle", () => {
    render(<SubmitButton pending={false} label="Simpan" pendingLabel="Menyimpan…" />);
    const button = screen.getByRole("button", { name: "Simpan" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button).toHaveProperty("disabled", false);
    expect(button.getAttribute("aria-busy")).toBe("false");
  });

  it("SubmitButton is disabled with aria-busy and the pending label while the action runs", () => {
    render(<SubmitButton pending label="Simpan" pendingLabel="Menyimpan…" spinner />);
    const button = screen.getByRole("button", { name: "Menyimpan…" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    // The spinner is decoration: hidden from assistive technology, so the name stays the label.
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows no spinner unless asked", () => {
    render(<SubmitButton pending label="Simpan" pendingLabel="Menyimpan…" />);
    expect(screen.getByRole("button").querySelector("svg")).toBeNull();
  });

  it("can be disabled without being busy, and keeps its label", () => {
    render(
      <SubmitButton pending={false} disabled label="Simpan" pendingLabel="Menyimpan…" />,
    );
    const button = screen.getByRole("button", { name: "Simpan" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("false");
  });
});
