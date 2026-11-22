// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { AiStatusLine } from "./AiStatusLine";

afterEach(cleanup);

describe("AiStatusLine", () => {
  it.each([
    ["ready", "Layanan AI siap digunakan"],
    ["working", "AI sedang bekerja"],
    ["waiting", "Menunggu kuota AI"],
  ] as const)("shows icon and text for %s", (kind, text) => {
    renderWithIntl(<AiStatusLine kind={kind} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(text);
    expect(status.querySelector("svg")).not.toBeNull();
  });

  it("shows the resume detail when waiting", () => {
    renderWithIntl(
      <AiStatusLine
        kind="waiting"
        detail="Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30"
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Menunggu kuota AI");
    expect(status.textContent).toContain("14.30");
    expect(status.className).toContain("break-words");
  });
});
