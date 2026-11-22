// Pure helpers for the topic picker. No server imports: client components use this module, so it
// may only import TYPES from the repository.
import type { TopicWithObjectives } from "./repository";

export type PickerGrade = 7 | 8 | 9;

type ParamValue = string | string[] | undefined;

const first = (value: ParamValue): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function parsePickerParams(
  raw: { grade?: ParamValue; topic?: ParamValue },
  topics: readonly { stableKey: string }[],
): { grade: 8; topicKey: string | null; requestedGrade: PickerGrade | null } {
  const grade = first(raw.grade);
  const requestedGrade: PickerGrade | null =
    grade === "7" ? 7 : grade === "8" ? 8 : grade === "9" ? 9 : null;
  const key = first(raw.topic);
  const topicKey =
    key !== undefined && topics.some((t) => t.stableKey === key) ? key : null;
  return { grade: 8, topicKey, requestedGrade };
}

type Searchable = Pick<
  TopicWithObjectives,
  "title" | "scopeNotes" | "element" | "objectives"
>;

function haystack(topic: Searchable): string {
  return [
    topic.title,
    topic.scopeNotes,
    topic.element.name,
    ...topic.objectives.map((o) => o.text),
  ]
    .join("\n")
    .toLowerCase();
}

// Every word of the query must occur somewhere in the topic (title, scope notes, element name or
// any objective text); an empty query matches everything. Order is preserved.
export function filterTopics<T extends Searchable>(
  topics: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...topics];
  return topics.filter((topic) => {
    const text = haystack(topic);
    return words.every((word) => text.includes(word));
  });
}

export interface ElementGroup<T> {
  element: { code: string; name: string };
  topics: T[];
}

export function groupByElement<T extends { element: { code: string; name: string } }>(
  topics: readonly T[],
): ElementGroup<T>[] {
  const groups = new Map<string, ElementGroup<T>>();
  for (const topic of topics) {
    const existing = groups.get(topic.element.code);
    if (existing) {
      existing.topics.push(topic);
    } else {
      groups.set(topic.element.code, {
        element: { code: topic.element.code, name: topic.element.name },
        topics: [topic],
      });
    }
  }
  return [...groups.values()];
}

export function pickerHref(grade: 8, topicKey: string | null): string {
  const base = `/generate?grade=${String(grade)}`;
  return topicKey === null ? base : `${base}&topic=${encodeURIComponent(topicKey)}`;
}
