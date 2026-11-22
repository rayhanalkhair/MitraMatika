import { describe, expect, it } from "vitest";
import type { TopicDetail } from "@/features/curriculum";
import { buildContextPack } from "./context-pack";

const topic: TopicDetail = {
  id: "44444444-4444-4444-8444-444444444444",
  stableKey: "spldv",
  grade: 8,
  title: "SPLDV",
  scopeNotes: "Cakupan SPLDV",
  sourceRef: "ref-2",
  sortOrder: 1,
  element: { code: "aljabar", name: "Aljabar", outcomeText: "CP aljabar" },
  objectives: [
    { id: "o1", code: "TP-1", text: "Satu", sourceRef: "r1" },
    { id: "o2", code: "TP-2", text: "Dua", sourceRef: "r2" },
  ],
  version: {
    id: "33333333-3333-4333-8333-333333333333",
    code: "v1",
    title: "CP",
    sourceTitle: "Sumber",
    sourceUrl: "https://example.test",
    decreeRef: "SK 1",
    publishedOn: "2025-07-16",
    retrievedOn: "2026-09-23",
  },
};

describe("buildContextPack", () => {
  it("maps the topic and the request into the prompt parameters", () => {
    expect(buildContextPack(topic, { difficulty: "sulit", quantity: 3 })).toEqual({
      grade: 8,
      topicTitle: "SPLDV",
      topicScopeNotes: "Cakupan SPLDV",
      objectives: [
        { code: "TP-1", text: "Satu" },
        { code: "TP-2", text: "Dua" },
      ],
      difficulty: "sulit",
      count: 3,
      dataClass: "C0",
    });
  });

  it("works for a topic without objectives", () => {
    const pack = buildContextPack(
      { ...topic, objectives: [] },
      { difficulty: "mudah", quantity: 1 },
    );
    expect(pack.objectives).toEqual([]);
  });
});
