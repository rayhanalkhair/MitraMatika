import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname);
const featuresDir = path.join(srcDir, "features");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("source layout", () => {
  it("has no src/modules or src/platform directory", () => {
    expect(existsSync(path.join(srcDir, "modules"))).toBe(false);
    expect(existsSync(path.join(srcDir, "platform"))).toBe(false);
  });

  it("gives every feature an index.ts", () => {
    const features = readdirSync(featuresDir).filter((name) =>
      statSync(path.join(featuresDir, name)).isDirectory(),
    );
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(existsSync(path.join(featuresDir, feature, "index.ts")), feature).toBe(true);
    }
  });

  it("never imports the retired @/modules or @/platform aliases", () => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => file !== import.meta.filename)
      .filter((file) => /@\/(modules|platform)(\/|["'])/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcDir, file));
    expect(offenders).toEqual([]);
  });
});
