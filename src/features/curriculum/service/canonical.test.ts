import { describe, expect, it } from "vitest";
import { canonicalizeSeed, canonicalizeStored, type StoredCurriculum } from "./canonical";
import type { CurriculumSeed } from "../schema/seed-schema";

const seed = (): CurriculumSeed => ({
  version: {
    code: "test-v1",
    title: "Test",
    sourceTitle: "Sumber",
    sourceUrl: "https://example.test/s",
    publishedOn: "2025-07-16",
    retrievedOn: "2026-09-23",
  },
  elements: [
    { code: "bilangan", name: "Bilangan", outcomeText: "CP bilangan" },
    { code: "aljabar", name: "Aljabar", outcomeText: "CP aljabar" },
  ],
  topics: [
    {
      stableKey: "pangkat",
      grade: 8,
      elementCode: "bilangan",
      title: "Pangkat",
      scopeNotes: "Catatan",
      sourceRef: "ref-1",
      sortOrder: 1,
      objectives: [
        { code: "TP-2", text: "Dua", sourceRef: "r" },
        { code: "TP-1", text: "Satu", sourceRef: "r" },
      ],
    },
    {
      stableKey: "spldv",
      grade: 8,
      elementCode: "aljabar",
      title: "SPLDV",
      scopeNotes: "Catatan",
      sourceRef: "ref-2",
      sortOrder: 2,
      objectives: [{ code: "TP-3", text: "Tiga", sourceRef: "r" }],
    },
  ],
});

// The shape the writer reads back from the database for the same content.
const stored = (): StoredCurriculum => ({
  version: {
    code: "test-v1",
    title: "Test",
    sourceTitle: "Sumber",
    sourceUrl: "https://example.test/s",
    decreeRef: null,
    publishedOn: "2025-07-16",
    retrievedOn: "2026-09-23",
  },
  elements: [
    { id: "e2", code: "aljabar", name: "Aljabar", outcomeText: "CP aljabar" },
    { id: "e1", code: "bilangan", name: "Bilangan", outcomeText: "CP bilangan" },
  ],
  topics: [
    {
      id: "t2",
      elementId: "e2",
      grade: 8,
      stableKey: "spldv",
      title: "SPLDV",
      scopeNotes: "Catatan",
      sourceRef: "ref-2",
      sortOrder: 2,
    },
    {
      id: "t1",
      elementId: "e1",
      grade: 8,
      stableKey: "pangkat",
      title: "Pangkat",
      scopeNotes: "Catatan",
      sourceRef: "ref-1",
      sortOrder: 1,
    },
  ],
  objectives: [
    { topicId: "t1", code: "TP-1", text: "Satu", sourceRef: "r" },
    { topicId: "t2", code: "TP-3", text: "Tiga", sourceRef: "r" },
    { topicId: "t1", code: "TP-2", text: "Dua", sourceRef: "r" },
  ],
});

describe("canonicalize", () => {
  it("treats the same content as equal regardless of ordering and ids", () => {
    expect(canonicalizeSeed(seed())).toBe(canonicalizeStored(stored()));
  });

  it("treats a missing decreeRef like a null one", () => {
    const withUndefined = seed();
    withUndefined.version.decreeRef = undefined;
    expect(canonicalizeSeed(withUndefined)).toBe(canonicalizeStored(stored()));
  });

  it.each([
    ["a version title", (s: CurriculumSeed) => void (s.version.title = "Lain")],
    ["an element name", (s: CurriculumSeed) => void (s.elements[0].name = "Lain")],
    ["a topic title", (s: CurriculumSeed) => void (s.topics[0].title = "Lain")],
    ["a topic sort order", (s: CurriculumSeed) => void (s.topics[0].sortOrder = 9)],
    [
      "a topic's element",
      (s: CurriculumSeed) => void (s.topics[0].elementCode = "aljabar"),
    ],
    [
      "an objective text",
      (s: CurriculumSeed) => void (s.topics[0].objectives[0].text = "Lain"),
    ],
    ["a removed objective", (s: CurriculumSeed) => void s.topics[0].objectives.pop()],
    ["a removed topic", (s: CurriculumSeed) => void s.topics.pop()],
  ])("detects %s", (_name, mutate) => {
    const changed = seed();
    mutate(changed);
    expect(canonicalizeSeed(changed)).not.toBe(canonicalizeStored(stored()));
  });
});
