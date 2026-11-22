import { describe, expect, it } from "vitest";
import { numberedOrder, shuffledOrder } from "./shuffle";

const ids = (n: number, prefix = "i") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

describe("shuffledOrder", () => {
  it("is a permutation of the input and leaves the input untouched", () => {
    const input = ids(25);
    const copy = [...input];
    const result = shuffledOrder(input, 12345);
    expect(input).toEqual(copy);
    expect([...result].sort()).toEqual([...input].sort());
  });

  it("gives the same order for the same seed, every time", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(shuffledOrder(ids(20), seed)).toEqual(shuffledOrder(ids(20), seed));
    }
  });

  it("gives different orders for different seeds", () => {
    const input = ids(10);
    expect(shuffledOrder(input, 1)).not.toEqual(shuffledOrder(input, 2));
    const orders = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) {
      orders.add(shuffledOrder(input, seed).join(","));
    }
    // 10! orders: 100 seeds collide at most a handful of times.
    expect(orders.size).toBeGreaterThan(95);
  });

  it("actually moves items (not the identity for most seeds)", () => {
    const input = ids(10);
    let unchanged = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      if (shuffledOrder(input, seed).join() === input.join()) unchanged += 1;
    }
    expect(unchanged).toBe(0);
  });

  it("handles empty and single lists and any 32-bit seed", () => {
    expect(shuffledOrder([], 9)).toEqual([]);
    expect(shuffledOrder(["a"], 9)).toEqual(["a"]);
    expect(shuffledOrder(ids(5), 0)).toHaveLength(5);
    expect(shuffledOrder(ids(5), 2147483647)).toHaveLength(5);
    expect(shuffledOrder(ids(5), -5)).toHaveLength(5);
  });
});

describe("numberedOrder", () => {
  const sections = [
    { id: "s1", itemIds: ids(6, "a") },
    { id: "s2", itemIds: [] },
    { id: "s3", itemIds: ids(4, "c") },
  ];

  it("without a seed keeps the outline order and numbers 1..n across sections", () => {
    const result = numberedOrder(sections, null);
    expect(result.map((section) => section.sectionId)).toEqual(["s1", "s2", "s3"]);
    expect(result[0].items.map((item) => item.itemId)).toEqual(ids(6, "a"));
    expect(result.flatMap((section) => section.items.map((item) => item.number))).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
  });

  it("with a seed keeps sections in place and shuffles items only within their section", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const result = numberedOrder(sections, seed);
      expect(result.map((section) => section.sectionId)).toEqual(["s1", "s2", "s3"]);
      expect([...result[0].items.map((item) => item.itemId)].sort()).toEqual(ids(6, "a"));
      expect(result[1].items).toEqual([]);
      expect([...result[2].items.map((item) => item.itemId)].sort()).toEqual(ids(4, "c"));
      // Numbers (what the paper, the key and the solutions print) follow the shuffled order.
      expect(
        result.flatMap((section) => section.items.map((item) => item.number)),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  it("is deterministic and changes with the seed", () => {
    expect(numberedOrder(sections, 77)).toEqual(numberedOrder(sections, 77));
    expect(numberedOrder(sections, 77)).not.toEqual(numberedOrder(sections, 78));
  });

  it("shuffles two sections of the same size differently", () => {
    const twins = [
      { id: "x", itemIds: ids(8, "x") },
      { id: "y", itemIds: ids(8, "y") },
    ];
    let same = 0;
    for (let seed = 1; seed <= 50; seed += 1) {
      const [x, y] = numberedOrder(twins, seed);
      const pattern = (items: { itemId: string }[]) =>
        items.map((item) => item.itemId.slice(1)).join();
      if (pattern(x.items) === pattern(y.items)) same += 1;
    }
    expect(same).toBeLessThan(3);
  });
});
