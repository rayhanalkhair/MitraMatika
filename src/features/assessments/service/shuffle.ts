// The seeded shuffle (decision 4), pure. With shuffling on, the assessment stores one integer seed;
// the order is a function of that seed and the outline, so the same seed always gives the same
// paper. Sections stay in place; items move only within their own section.
//
// Numbering: the question numbers printed on the paper, in the answer key and in the solutions all
// come from `numberedOrder`, so the three documents always agree with each other (the key follows
// the shuffled order). The editor keeps showing the outline order the teacher arranged.

/** mulberry32: a small, fast 32-bit PRNG; good enough to shuffle a question paper. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The items in a deterministic shuffled order (Fisher-Yates driven by mulberry32 seeded with
 * `seed`). The input is not changed. The same ids in the same order with the same seed always give
 * the same result.
 */
export function shuffledOrder(itemIds: string[], seed: number): string[] {
  const result = [...itemIds];
  const random = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** A different seed per section, so two sections of the same size are not shuffled alike. */
const sectionSeed = (seed: number, index: number) =>
  (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;

export interface NumberedSection {
  sectionId: string;
  items: { itemId: string; number: number }[];
}

/**
 * The order and numbers the documents print: sections in outline order, items in outline order
 * (no seed) or shuffled within their section (seed), numbered 1..n across the whole paper.
 */
export function numberedOrder(
  sections: { id: string; itemIds: string[] }[],
  seed: number | null,
): NumberedSection[] {
  let number = 0;
  return sections.map((section, index) => {
    const order =
      seed === null
        ? section.itemIds
        : shuffledOrder(section.itemIds, sectionSeed(seed, index));
    return {
      sectionId: section.id,
      items: order.map((itemId) => {
        number += 1;
        return { itemId, number };
      }),
    };
  });
}
