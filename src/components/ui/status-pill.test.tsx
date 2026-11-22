// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusPill } from "./status-pill";

afterEach(cleanup);

describe("StatusPill", () => {
  it.each(["success", "warning", "destructive", "ai", "neutral"] as const)(
    "renders the %s tone with its children",
    (tone) => {
      render(<StatusPill tone={tone}>Label</StatusPill>);
      const pill = screen.getByText("Label");
      expect(pill.getAttribute("data-tone")).toBe(tone);
      expect(pill.className).toContain("rounded-full");
    },
  );

  it("uses the ai tone classes", () => {
    render(<StatusPill tone="ai">Label</StatusPill>);
    expect(screen.getByText("Label").className).toContain("bg-ai-soft");
  });
});
