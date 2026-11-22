import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSeed, type CurriculumSeed } from "../schema/seed-schema";

export function loadSeedFromFile(path: string): CurriculumSeed {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Seed kurikulum tidak dapat dibaca atau diurai (${path}): ${message}`,
    );
  }

  const result = validateSeed(raw);
  if (!result.ok) {
    throw new Error(`Seed kurikulum tidak valid (${path}): ${result.errors.join("; ")}`);
  }
  return result.seed;
}

export function loadGrade8SeedV1(): CurriculumSeed {
  return loadSeedFromFile(join(process.cwd(), "data/curriculum/grade-8-v1.json"));
}
