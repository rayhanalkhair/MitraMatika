import type { CurriculumSeed } from "../schema/seed-schema";

export interface StoredCurriculum {
  version: {
    code: string;
    title: string;
    sourceTitle: string;
    sourceUrl: string;
    decreeRef: string | null;
    publishedOn: string;
    retrievedOn: string;
  };
  elements: { id: string; code: string; name: string; outcomeText: string }[];
  topics: {
    id: string;
    elementId: string;
    grade: number;
    stableKey: string;
    title: string;
    scopeNotes: string;
    sourceRef: string;
    sortOrder: number;
  }[];
  objectives: { topicId: string; code: string; text: string; sourceRef: string }[];
}

interface Canonical {
  version: StoredCurriculum["version"];
  elements: { code: string; name: string; outcomeText: string }[];
  topics: {
    grade: number;
    stableKey: string;
    elementCode: string;
    title: string;
    scopeNotes: string;
    sourceRef: string;
    sortOrder: number;
    objectives: { code: string; text: string; sourceRef: string }[];
  }[];
}

const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code);
const byTopicKey = (
  a: { grade: number; stableKey: string },
  b: { grade: number; stableKey: string },
) => a.grade - b.grade || a.stableKey.localeCompare(b.stableKey);

function serialise(canonical: Canonical): string {
  return JSON.stringify(canonical);
}

// Two seeds (or a seed and the stored rows) have identical content exactly when their canonical
// strings are equal. Ids and ordering of arrays do not matter; values do.
export function canonicalizeSeed(seed: CurriculumSeed): string {
  return serialise({
    version: {
      code: seed.version.code,
      title: seed.version.title,
      sourceTitle: seed.version.sourceTitle,
      sourceUrl: seed.version.sourceUrl,
      decreeRef: seed.version.decreeRef ?? null,
      publishedOn: seed.version.publishedOn,
      retrievedOn: seed.version.retrievedOn,
    },
    elements: seed.elements
      .map((e) => ({ code: e.code, name: e.name, outcomeText: e.outcomeText }))
      .sort(byCode),
    topics: seed.topics
      .map((t) => ({
        grade: t.grade,
        stableKey: t.stableKey,
        elementCode: t.elementCode,
        title: t.title,
        scopeNotes: t.scopeNotes,
        sourceRef: t.sourceRef,
        sortOrder: t.sortOrder,
        objectives: t.objectives
          .map((o) => ({ code: o.code, text: o.text, sourceRef: o.sourceRef }))
          .sort(byCode),
      }))
      .sort(byTopicKey),
  });
}

export function canonicalizeStored(stored: StoredCurriculum): string {
  const elementCode = new Map(stored.elements.map((e) => [e.id, e.code]));
  const objectivesOf = (topicId: string) =>
    stored.objectives
      .filter((o) => o.topicId === topicId)
      .map((o) => ({ code: o.code, text: o.text, sourceRef: o.sourceRef }))
      .sort(byCode);
  return serialise({
    version: stored.version,
    elements: stored.elements
      .map((e) => ({ code: e.code, name: e.name, outcomeText: e.outcomeText }))
      .sort(byCode),
    topics: stored.topics
      .map((t) => ({
        grade: t.grade,
        stableKey: t.stableKey,
        elementCode: elementCode.get(t.elementId) ?? "",
        title: t.title,
        scopeNotes: t.scopeNotes,
        sourceRef: t.sourceRef,
        sortOrder: t.sortOrder,
        objectives: objectivesOf(t.id),
      }))
      .sort(byTopicKey),
  });
}
