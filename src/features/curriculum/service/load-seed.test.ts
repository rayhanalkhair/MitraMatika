import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGrade8SeedV1, loadSeedFromFile } from "./load-seed";

describe("loadGrade8SeedV1", () => {
  it("loads and validates the Grade 8 v1 curriculum seed", () => {
    const seed = loadGrade8SeedV1();
    expect(seed.elements).toHaveLength(5);
    expect(seed.topics.length).toBeGreaterThanOrEqual(1);
    expect(seed.topics.every((topic) => topic.grade === 8)).toBe(true);
  });

  it("covers every CP element referenced by at least one topic", () => {
    const seed = loadGrade8SeedV1();
    const elementCodes = new Set(seed.elements.map((element) => element.code));
    const referencedCodes = new Set(seed.topics.map((topic) => topic.elementCode));
    for (const code of referencedCodes) {
      expect(elementCodes.has(code)).toBe(true);
    }
    expect(referencedCodes.size).toBe(5);
  });

  it("includes teorema-pythagoras as a topic (vertical slice default, B22)", () => {
    const seed = loadGrade8SeedV1();
    expect(seed.topics.some((topic) => topic.stableKey === "teorema-pythagoras")).toBe(
      true,
    );
  });

  it("gives every topic at least one learning objective with a source reference", () => {
    const seed = loadGrade8SeedV1();
    for (const topic of seed.topics) {
      expect(topic.objectives.length).toBeGreaterThanOrEqual(1);
      for (const objective of topic.objectives) {
        expect(objective.sourceRef.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("loadSeedFromFile", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("throws an Indonesian error when the file cannot be read or parsed as JSON", () => {
    tempDir = mkdtempSync(join(tmpdir(), "curriculum-seed-"));
    const brokenPath = join(tempDir, "broken.json");
    writeFileSync(brokenPath, "{ this is not valid json", "utf-8");

    expect(() => loadSeedFromFile(brokenPath)).toThrow(
      /Seed kurikulum tidak dapat dibaca/,
    );
  });

  it("throws an Indonesian error when the seed violates a business rule", () => {
    tempDir = mkdtempSync(join(tmpdir(), "curriculum-seed-"));
    const invalidPath = join(tempDir, "invalid.json");
    const seed = {
      version: {
        code: "test-seed",
        title: "Test Seed",
        sourceTitle: "Test Source",
        sourceUrl: "https://example.com",
        publishedOn: "2026-01-01",
        retrievedOn: "2026-01-01",
      },
      elements: [{ code: "bilangan", name: "Bilangan", outcomeText: "Contoh." }],
      topics: [
        {
          stableKey: "topik-duplikat",
          grade: 8,
          elementCode: "bilangan",
          title: "Topik A",
          scopeNotes: "Contoh.",
          sourceRef: "Contoh.",
          sortOrder: 1,
          objectives: [{ code: "TP-01", text: "Contoh.", sourceRef: "Contoh." }],
        },
        {
          stableKey: "topik-duplikat",
          grade: 8,
          elementCode: "bilangan",
          title: "Topik B",
          scopeNotes: "Contoh.",
          sourceRef: "Contoh.",
          sortOrder: 2,
          objectives: [{ code: "TP-02", text: "Contoh.", sourceRef: "Contoh." }],
        },
      ],
    };
    writeFileSync(invalidPath, JSON.stringify(seed), "utf-8");

    expect(() => loadSeedFromFile(invalidPath)).toThrow(/Seed kurikulum tidak valid/);
  });
});
