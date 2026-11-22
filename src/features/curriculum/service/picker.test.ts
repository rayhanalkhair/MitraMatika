import { describe, expect, it } from "vitest";
import { filterTopics, groupByElement, parsePickerParams, pickerHref } from "./picker";
import type { TopicWithObjectives } from "./repository";

type T = TopicWithObjectives;

const topic = (over: Partial<T> & { stableKey: string }): T =>
  ({
    id: over.stableKey,
    grade: 8,
    title: "Judul",
    scopeNotes: "Catatan",
    sortOrder: 1,
    sourceRef: "ref",
    element: { code: "bilangan", name: "Bilangan" },
    objectives: [],
    ...over,
  }) as unknown as T;

const topics: T[] = [
  topic({
    stableKey: "pangkat",
    title: "Bilangan Berpangkat dan Bentuk Akar",
    scopeNotes: "Eksponen dan akar kuadrat",
    element: { code: "bilangan", name: "Bilangan" },
    objectives: [
      { id: "1", code: "TP-1", text: "Menyederhanakan bentuk akar", sourceRef: "r" },
    ],
  }),
  topic({
    stableKey: "spldv",
    title: "Sistem Persamaan Linear Dua Variabel",
    scopeNotes: "Substitusi dan eliminasi",
    element: { code: "aljabar", name: "Aljabar" },
    objectives: [{ id: "2", code: "TP-2", text: "Menyelesaikan SPLDV", sourceRef: "r" }],
  }),
  topic({
    stableKey: "garis",
    title: "Persamaan Garis Lurus",
    scopeNotes: "Gradien",
    element: { code: "aljabar", name: "Aljabar" },
    objectives: [],
  }),
];

describe("parsePickerParams", () => {
  it("defaults to grade 8 with no topic", () => {
    expect(parsePickerParams({}, topics)).toEqual({
      grade: 8,
      topicKey: null,
      requestedGrade: null,
    });
  });

  it("keeps a topic key that exists in the catalogue", () => {
    expect(parsePickerParams({ grade: "8", topic: "spldv" }, topics)).toMatchObject({
      grade: 8,
      topicKey: "spldv",
      requestedGrade: 8,
    });
  });

  it("drops an unknown topic key", () => {
    expect(parsePickerParams({ topic: "tidak-ada" }, topics).topicKey).toBeNull();
  });

  it.each(["7", "9"])(
    "falls back to grade 8 and reports the requested grade %s",
    (grade) => {
      expect(parsePickerParams({ grade }, topics)).toMatchObject({
        grade: 8,
        requestedGrade: Number(grade),
      });
    },
  );

  it.each(["abc", "", "10", "0"])("treats grade=%j as not requested", (grade) => {
    expect(parsePickerParams({ grade }, topics)).toMatchObject({
      grade: 8,
      requestedGrade: null,
    });
  });

  it("uses the first value of an array parameter", () => {
    expect(parsePickerParams({ topic: ["garis", "spldv"] }, topics).topicKey).toBe(
      "garis",
    );
  });
});

describe("filterTopics", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterTopics(topics, "")).toHaveLength(3);
    expect(filterTopics(topics, "   ")).toHaveLength(3);
  });

  it("matches the title case-insensitively", () => {
    expect(filterTopics(topics, "linear").map((t) => t.stableKey)).toEqual(["spldv"]);
    expect(filterTopics(topics, "LINEAR").map((t) => t.stableKey)).toEqual(["spldv"]);
  });

  it("matches scope notes, element name and objective text", () => {
    expect(filterTopics(topics, "eliminasi").map((t) => t.stableKey)).toEqual(["spldv"]);
    expect(filterTopics(topics, "aljabar").map((t) => t.stableKey)).toEqual([
      "spldv",
      "garis",
    ]);
    expect(filterTopics(topics, "menyederhanakan").map((t) => t.stableKey)).toEqual([
      "pangkat",
    ]);
  });

  it("requires every word to match (AND), in any field", () => {
    expect(filterTopics(topics, "aljabar gradien").map((t) => t.stableKey)).toEqual([
      "garis",
    ]);
    expect(filterTopics(topics, "aljabar akar")).toEqual([]);
  });

  it("keeps the input order", () => {
    expect(filterTopics(topics, "persamaan").map((t) => t.stableKey)).toEqual([
      "spldv",
      "garis",
    ]);
  });
});

describe("groupByElement", () => {
  it("groups by element in first-seen order, keeping topic order inside a group", () => {
    const groups = groupByElement(topics);
    expect(groups.map((g) => g.element.code)).toEqual(["bilangan", "aljabar"]);
    expect(groups[1]?.topics.map((t) => t.stableKey)).toEqual(["spldv", "garis"]);
    expect(groups[0]?.element).toEqual({ code: "bilangan", name: "Bilangan" });
  });

  it("returns [] for no topics", () => {
    expect(groupByElement([])).toEqual([]);
  });
});

describe("pickerHref", () => {
  it("builds the base href without a topic", () => {
    expect(pickerHref(8, null)).toBe("/generate?grade=8");
  });

  it("appends and encodes the topic key", () => {
    expect(pickerHref(8, "spldv")).toBe("/generate?grade=8&topic=spldv");
    expect(pickerHref(8, "a b&c")).toBe("/generate?grade=8&topic=a%20b%26c");
  });
});
