import { describe, expect, it } from "vitest";
import { hashSeed, seededShuffle } from "./seeded-shuffle";

describe("hashSeed", () => {
  it("is stable and differs for different strings", () => {
    expect(hashSeed("r:0")).toBe(hashSeed("r:0"));
    expect(hashSeed("r:0")).not.toBe(hashSeed("r:1"));
    expect(Number.isInteger(hashSeed("r:0"))).toBe(true);
  });
});

describe("seededShuffle", () => {
  const items = ["a", "b", "c", "d"];

  it("returns a permutation and does not mutate the input", () => {
    const copy = [...items];
    const out = seededShuffle(items, 42);
    expect(items).toEqual(copy);
    expect([...out].sort()).toEqual(copy);
  });

  it("is deterministic for the same seed", () => {
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, 7));
  });

  it("differs across seeds", () => {
    const orders = new Set<string>();
    for (let s = 0; s < 50; s += 1) orders.add(seededShuffle(items, s).join(""));
    expect(orders.size).toBeGreaterThan(10);
  });

  it("handles empty and single-item arrays", () => {
    expect(seededShuffle([], 1)).toEqual([]);
    expect(seededShuffle(["x"], 1)).toEqual(["x"]);
  });
});
