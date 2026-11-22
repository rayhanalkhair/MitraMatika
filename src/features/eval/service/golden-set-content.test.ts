import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedSchema } from "@/features/curriculum";
import {
  validateGoldenGenerationSet,
  validateGoldenOcrManifest,
  validateGoldenSolverSet,
} from "../schema/golden-set-schema";

const goldenSetDir = join(process.cwd(), "data", "golden-set");
const curriculumDir = join(process.cwd(), "data", "curriculum");

async function readJson(dir: string, fileName: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, fileName), "utf-8"));
}

async function knownTopicKeys(): Promise<Set<string>> {
  const seed = seedSchema.parse(await readJson(curriculumDir, "grade-8-v1.json"));
  return new Set(seed.topics.map((t) => t.stableKey));
}

describe("generation-specs.v1.json", () => {
  it("is well-formed with unique ids", async () => {
    const raw = await readJson(goldenSetDir, "generation-specs.v1.json");
    const result = validateGoldenGenerationSet(raw);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("has exactly 20 items, per P0-16's spec", async () => {
    const raw = await readJson(goldenSetDir, "generation-specs.v1.json");
    const result = validateGoldenGenerationSet(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.items).toHaveLength(20);
  });

  it("every topicStableKey exists in the validated Grade 8 curriculum seed", async () => {
    const raw = await readJson(goldenSetDir, "generation-specs.v1.json");
    const result = validateGoldenGenerationSet(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const known = await knownTopicKeys();
    for (const item of result.value.items) {
      expect(
        known.has(item.topicStableKey),
        `unknown topic: ${item.topicStableKey}`,
      ).toBe(true);
    }
  });
});

describe("solver-problems.v1.json", () => {
  it("is well-formed with unique ids", async () => {
    const raw = await readJson(goldenSetDir, "solver-problems.v1.json");
    const result = validateGoldenSolverSet(raw);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("has exactly 10 items, per P0-16's spec", async () => {
    const raw = await readJson(goldenSetDir, "solver-problems.v1.json");
    const result = validateGoldenSolverSet(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.items).toHaveLength(10);
  });

  it("every topicStableKey exists in the validated Grade 8 curriculum seed", async () => {
    const raw = await readJson(goldenSetDir, "solver-problems.v1.json");
    const result = validateGoldenSolverSet(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const known = await knownTopicKeys();
    for (const item of result.value.items) {
      expect(
        known.has(item.topicStableKey),
        `unknown topic: ${item.topicStableKey}`,
      ).toBe(true);
    }
  });

  it("every option list contains the correctLabel exactly once", async () => {
    const raw = await readJson(goldenSetDir, "solver-problems.v1.json");
    const result = validateGoldenSolverSet(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    for (const item of result.value.items) {
      const matches = item.options.filter((o) => o.label === item.correctLabel);
      expect(matches, `item ${item.id}`).toHaveLength(1);
    }
  });
});

describe("ocr-pages-manifest.v1.json", () => {
  it("is well-formed with unique ids", async () => {
    const raw = await readJson(goldenSetDir, "ocr-pages-manifest.v1.json");
    const result = validateGoldenOcrManifest(raw);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("has exactly 10 items, per P0-16's spec", async () => {
    const raw = await readJson(goldenSetDir, "ocr-pages-manifest.v1.json");
    const result = validateGoldenOcrManifest(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.value.items).toHaveLength(10);
  });

  it("never contains real transcribed content, only ids and hashes", async () => {
    const raw = await readJson(goldenSetDir, "ocr-pages-manifest.v1.json");
    const text = JSON.stringify(raw);
    expect(text).not.toContain("expectedText_md");
  });

  it("covers all three OCR fixture kinds", async () => {
    const raw = await readJson(goldenSetDir, "ocr-pages-manifest.v1.json");
    const result = validateGoldenOcrManifest(raw);
    if (!result.ok) throw new Error(result.errors.join("; "));
    const kinds = new Set(result.value.items.map((i) => i.kind));
    expect(kinds.has("text_pdf")).toBe(true);
    expect(kinds.has("scan")).toBe(true);
    expect(kinds.has("phone_photo")).toBe(true);
  });
});
