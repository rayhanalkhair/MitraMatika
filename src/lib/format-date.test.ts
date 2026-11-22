import { describe, expect, it } from "vitest";
import { formatBankDate, type ViewerFormat } from "./format-date";

const jakarta: ViewerFormat = { locale: "id", timeZone: "Asia/Jakarta" };

describe("formatBankDate", () => {
  it("formats in Asia/Jakarta, crossing midnight UTC", () => {
    expect(formatBankDate("2026-11-08T20:30:00.000Z", jakarta)).toBe("9 November 2026");
    expect(formatBankDate("2026-11-08T10:00:00.000Z", jakarta)).toBe("8 November 2026");
  });

  it("renders 2026-11-08T18:00:00Z as 9 November in Jakarta and 8 November in UTC", () => {
    expect(formatBankDate("2026-11-08T18:00:00Z", jakarta)).toBe("9 November 2026");
    expect(
      formatBankDate("2026-11-08T18:00:00Z", { locale: "id", timeZone: "UTC" }),
    ).toBe("8 November 2026");
  });

  it("uses the active locale", () => {
    expect(
      formatBankDate("2026-11-08T18:00:00Z", { locale: "en", timeZone: "UTC" }),
    ).toBe("November 8, 2026");
    expect(
      formatBankDate("2026-03-01T00:00:00Z", { locale: "id", timeZone: "UTC" }),
    ).toBe("1 Maret 2026");
  });
});

describe("formatBankDate with an unreadable value", () => {
  it("returns the input instead of throwing", () => {
    expect(formatBankDate("not-a-date", { locale: "id", timeZone: "UTC" })).toBe(
      "not-a-date",
    );
  });
});
