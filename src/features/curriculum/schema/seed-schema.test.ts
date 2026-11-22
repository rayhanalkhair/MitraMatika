import { describe, expect, it } from "vitest";
import { validateSeed } from "./seed-schema";

// Synthetic fixture: NOT real curriculum content.
const valid = () => ({
  version: {
    code: "fixture-v1",
    title: "Fixture",
    sourceTitle: "Synthetic source",
    sourceUrl: "https://example.org/fixture",
    publishedOn: "2025-01-01",
    retrievedOn: "2026-09-21",
  },
  elements: [{ code: "EL1", name: "Elemen Satu", outcomeText: "Capaian satu" }],
  topics: [
    {
      stableKey: "topik-satu",
      grade: 8,
      elementCode: "EL1",
      title: "Topik Satu",
      scopeNotes: "Cakupan",
      sourceRef: "Sumber, hlm. 1",
      sortOrder: 1,
      objectives: [{ code: "TP-1", text: "Tujuan satu", sourceRef: "Sumber, hlm. 1" }],
    },
  ],
});

describe("validateSeed", () => {
  it("accepts a valid seed", () => {
    const result = validateSeed(valid());
    expect(result.ok).toBe(true);
  });

  it("rejects a grade outside 7 to 9", () => {
    const seed = valid();
    seed.topics[0].grade = 10;
    expect(validateSeed(seed).ok).toBe(false);
  });

  it("rejects a malformed stableKey", () => {
    const seed = valid();
    seed.topics[0].stableKey = "Topik Satu";
    expect(validateSeed(seed).ok).toBe(false);
  });

  it("rejects a malformed date", () => {
    const seed = valid();
    seed.version.publishedOn = "1 Januari 2025";
    expect(validateSeed(seed).ok).toBe(false);
  });

  it("rejects a topic with no objectives", () => {
    const seed = valid();
    seed.topics[0].objectives = [];
    expect(validateSeed(seed).ok).toBe(false);
  });

  it("rejects a topic that references an unknown element", () => {
    const seed = valid();
    seed.topics[0].elementCode = "NOPE";
    const result = validateSeed(seed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("NOPE");
  });

  it("rejects duplicate element codes", () => {
    const seed = valid();
    seed.elements.push({ ...seed.elements[0] });
    expect(validateSeed(seed).ok).toBe(false);
  });

  it("rejects duplicate stableKeys within a grade but allows the same key in another grade", () => {
    const dup = valid();
    dup.topics.push({
      ...dup.topics[0],
      title: "Salinan",
      objectives: [{ code: "TP-2", text: "x", sourceRef: "y" }],
    });
    expect(validateSeed(dup).ok).toBe(false);

    const otherGrade = valid();
    otherGrade.topics.push({
      ...otherGrade.topics[0],
      grade: 9,
      objectives: [{ code: "TP-2", text: "x", sourceRef: "y" }],
    });
    expect(validateSeed(otherGrade).ok).toBe(true);
  });

  it("rejects duplicate objective codes across the file", () => {
    const seed = valid();
    seed.topics.push({
      ...seed.topics[0],
      stableKey: "topik-dua",
      objectives: [{ code: "TP-1", text: "x", sourceRef: "y" }],
    });
    expect(validateSeed(seed).ok).toBe(false);
  });
});
