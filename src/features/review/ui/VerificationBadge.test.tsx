// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { VerificationBadge } from "./VerificationBadge";

afterEach(cleanup);

describe("VerificationBadge", () => {
  it.each([
    ["terverifikasi", "Terverifikasi otomatis"],
    ["dicek_silang", "Dicek silang AI"],
    ["belum_dapat_diverifikasi", "Belum dapat diverifikasi"],
    ["ketidaksesuaian", "Ditemukan ketidaksesuaian"],
    ["checking", "Sedang diperiksa"],
    ["waiting", "Menunggu pemeriksaan"],
  ] as const)("shows %s with an icon and the text", (status, text) => {
    const { container } = renderWithIntl(<VerificationBadge status={status} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(`[data-status="${status}"]`)).not.toBeNull();
  });

  it("cross-checked uses the ai tone class", () => {
    const { container } = renderWithIntl(<VerificationBadge status="dicek_silang" />);
    const badge = container.querySelector('[data-status="dicek_silang"]')!;
    expect(badge.className).toContain("bg-ai-soft");
    expect(badge.className).toContain("text-ai-foreground");
  });
});
