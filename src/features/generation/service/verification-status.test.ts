import { describe, expect, it } from "vitest";
import { fromDbStatus, isRegenerationMarker, toDbStatus } from "./verification-status";

describe("toDbStatus / fromDbStatus", () => {
  it("translates the cross-checked status in both directions", () => {
    expect(toDbStatus("dicek_silang")).toBe("dicek_silang_ai");
    expect(fromDbStatus("dicek_silang_ai")).toBe("dicek_silang");
  });

  it("leaves every other status alone", () => {
    for (const status of [
      "terverifikasi",
      "belum_dapat_diverifikasi",
      "ketidaksesuaian",
    ]) {
      expect(toDbStatus(status)).toBe(status);
      expect(fromDbStatus(status)).toBe(status);
    }
  });
});

describe("isRegenerationMarker", () => {
  it("recognises the marker shape", () => {
    expect(isRegenerationMarker({ regeneration: "failed" })).toBe(true);
  });

  it("does not take a real cross-check for a marker", () => {
    expect(isRegenerationMarker({ provider: "groq", model: "m", verdict: "agree" })).toBe(
      false,
    );
    expect(isRegenerationMarker(null)).toBe(false);
    expect(isRegenerationMarker("regeneration")).toBe(false);
  });
});
