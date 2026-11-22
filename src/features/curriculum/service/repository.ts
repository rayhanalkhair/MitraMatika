import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import {
  cpElements,
  curriculumVersions,
  learningObjectives,
  topics,
} from "@/lib/db/schema";

export type Grade = 7 | 8 | 9;

export interface CurriculumVersion {
  id: string;
  code: string;
  title: string;
  sourceTitle: string;
  sourceUrl: string;
  decreeRef: string | null;
  publishedOn: string;
  retrievedOn: string;
}

export interface TopicSummary {
  id: string;
  stableKey: string;
  grade: Grade;
  title: string;
  scopeNotes: string;
  sortOrder: number;
  element: { code: string; name: string };
}

export interface ObjectiveDetail {
  id: string;
  code: string;
  text: string;
  sourceRef: string;
}

export type TopicDetail = Omit<TopicSummary, "element"> & {
  sourceRef: string;
  element: { code: string; name: string; outcomeText: string };
  objectives: ObjectiveDetail[];
  version: CurriculumVersion;
};

export type TopicWithObjectives = TopicSummary & {
  sourceRef: string;
  objectives: ObjectiveDetail[];
};
export type TopicRef = { id: string } | { grade: Grade; stableKey: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const versionColumns = {
  id: curriculumVersions.id,
  code: curriculumVersions.code,
  title: curriculumVersions.title,
  sourceTitle: curriculumVersions.sourceTitle,
  sourceUrl: curriculumVersions.sourceUrl,
  decreeRef: curriculumVersions.decreeRef,
  publishedOn: curriculumVersions.publishedOn,
  retrievedOn: curriculumVersions.retrievedOn,
};

// Reads the curriculum catalogue (always the single active version). The tables have no owner and
// teachers have SELECT on them, so the same queries work on the service connection and under RLS.
export function createCurriculumRepository<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>) {
  async function getActiveVersion(): Promise<CurriculumVersion | null> {
    const rows = await db
      .select(versionColumns)
      .from(curriculumVersions)
      .where(eq(curriculumVersions.status, "active"))
      .orderBy(desc(curriculumVersions.publishedOn), desc(curriculumVersions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async function listTopics(grade: Grade): Promise<TopicSummary[]> {
    const version = await getActiveVersion();
    if (!version) return [];
    const rows = await db
      .select({
        id: topics.id,
        stableKey: topics.stableKey,
        grade: topics.grade,
        title: topics.title,
        scopeNotes: topics.scopeNotes,
        sortOrder: topics.sortOrder,
        elementCode: cpElements.code,
        elementName: cpElements.name,
      })
      .from(topics)
      .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
      .where(and(eq(topics.curriculumVersionId, version.id), eq(topics.grade, grade)))
      .orderBy(asc(topics.sortOrder), asc(topics.title));
    return rows.map((row) => ({
      id: row.id,
      stableKey: row.stableKey,
      grade: row.grade as Grade,
      title: row.title,
      scopeNotes: row.scopeNotes,
      sortOrder: row.sortOrder,
      element: { code: row.elementCode, name: row.elementName },
    }));
  }

  async function readTopicInVersion(
    version: CurriculumVersion,
    match: SQL | undefined,
  ): Promise<TopicDetail | null> {
    const rows = await db
      .select({
        id: topics.id,
        stableKey: topics.stableKey,
        grade: topics.grade,
        title: topics.title,
        scopeNotes: topics.scopeNotes,
        sourceRef: topics.sourceRef,
        sortOrder: topics.sortOrder,
        elementCode: cpElements.code,
        elementName: cpElements.name,
        elementOutcome: cpElements.outcomeText,
      })
      .from(topics)
      .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
      .where(and(eq(topics.curriculumVersionId, version.id), match))
      .limit(1);
    const row = rows.at(0);
    if (!row) return null;

    const objectives = await db
      .select({
        id: learningObjectives.id,
        code: learningObjectives.code,
        text: learningObjectives.text,
        sourceRef: learningObjectives.sourceRef,
      })
      .from(learningObjectives)
      .where(eq(learningObjectives.topicId, row.id))
      .orderBy(asc(learningObjectives.code));

    return {
      id: row.id,
      stableKey: row.stableKey,
      grade: row.grade as Grade,
      title: row.title,
      scopeNotes: row.scopeNotes,
      sourceRef: row.sourceRef,
      sortOrder: row.sortOrder,
      element: {
        code: row.elementCode,
        name: row.elementName,
        outcomeText: row.elementOutcome,
      },
      objectives,
      version,
    };
  }

  async function getTopic(ref: TopicRef): Promise<TopicDetail | null> {
    // A non-UUID id would raise Postgres 22P02; it cannot match any topic, so answer null.
    if ("id" in ref && !UUID_PATTERN.test(ref.id)) return null;
    const version = await getActiveVersion();
    if (!version) return null;
    const match =
      "id" in ref
        ? eq(topics.id, ref.id)
        : and(eq(topics.grade, ref.grade), eq(topics.stableKey, ref.stableKey));
    return readTopicInVersion(version, match);
  }

  // Reads a topic of a SPECIFIC version, whatever its status. A request keeps generating from the
  // version it was accepted under, even if a newer version was activated meanwhile.
  async function getTopicInVersion(
    topicId: string,
    versionId: string,
  ): Promise<TopicDetail | null> {
    if (!UUID_PATTERN.test(topicId) || !UUID_PATTERN.test(versionId)) return null;
    const rows = await db
      .select(versionColumns)
      .from(curriculumVersions)
      .where(eq(curriculumVersions.id, versionId))
      .limit(1);
    const version = rows.at(0);
    if (!version) return null;
    return readTopicInVersion(version, eq(topics.id, topicId));
  }
  async function listTopicsWithObjectives(grade: Grade): Promise<TopicWithObjectives[]> {
    const version = await getActiveVersion();
    if (!version) return [];
    const rows = await db
      .select({
        id: topics.id,
        stableKey: topics.stableKey,
        grade: topics.grade,
        title: topics.title,
        scopeNotes: topics.scopeNotes,
        sourceRef: topics.sourceRef,
        sortOrder: topics.sortOrder,
        elementCode: cpElements.code,
        elementName: cpElements.name,
      })
      .from(topics)
      .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
      .where(and(eq(topics.curriculumVersionId, version.id), eq(topics.grade, grade)))
      .orderBy(asc(topics.sortOrder), asc(topics.title));
    if (rows.length === 0) return [];

    const objectiveRows = await db
      .select({
        topicId: learningObjectives.topicId,
        id: learningObjectives.id,
        code: learningObjectives.code,
        text: learningObjectives.text,
        sourceRef: learningObjectives.sourceRef,
      })
      .from(learningObjectives)
      .where(
        inArray(
          learningObjectives.topicId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(learningObjectives.code));

    const byTopic = new Map<string, ObjectiveDetail[]>();
    for (const objective of objectiveRows) {
      const list = byTopic.get(objective.topicId) ?? [];
      list.push({
        id: objective.id,
        code: objective.code,
        text: objective.text,
        sourceRef: objective.sourceRef,
      });
      byTopic.set(objective.topicId, list);
    }

    return rows.map((row) => ({
      id: row.id,
      stableKey: row.stableKey,
      grade: row.grade as Grade,
      title: row.title,
      scopeNotes: row.scopeNotes,
      sourceRef: row.sourceRef,
      sortOrder: row.sortOrder,
      element: { code: row.elementCode, name: row.elementName },
      objectives: byTopic.get(row.id) ?? [],
    }));
  }
  return {
    getActiveVersion,
    listTopics,
    listTopicsWithObjectives,
    getTopic,
    getTopicInVersion,
  };
}

export type CurriculumRepository = ReturnType<typeof createCurriculumRepository>;
