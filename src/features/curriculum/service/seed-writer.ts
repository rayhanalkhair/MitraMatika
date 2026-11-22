import { eq, inArray } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import {
  cpElements,
  curriculumVersions,
  learningObjectives,
  topics,
} from "@/lib/db/schema";
import { canonicalizeSeed, canonicalizeStored } from "./canonical";
import type { CurriculumSeed } from "../schema/seed-schema";

export interface Counts {
  versions: number;
  elements: number;
  topics: number;
  objectives: number;
}

export interface WriteSeedOptions {
  activate: boolean;
  dryRun?: boolean;
}

export interface WriteSeedResult {
  versionCode: string;
  versionStatus: "draft" | "active" | "archived";
  created: Counts;
  updated: Counts;
  deleted: Counts;
  activated: boolean;
  archivedVersions: string[];
  unchanged: boolean;
}

// Raised for content the developer must resolve (an activated version that differs from the file,
// activating an archived version). The message is Indonesian and shown by the CLI as is.
export class SeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedConflictError";
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: WriteSeedResult) {
    super("dry run");
  }
}

const zero = (): Counts => ({ versions: 0, elements: 0, topics: 0, objectives: 0 });
const isEmpty = (c: Counts) => c.versions + c.elements + c.topics + c.objectives === 0;

type AnyDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

async function readStored(db: AnyDb, version: typeof curriculumVersions.$inferSelect) {
  const elements = await db
    .select()
    .from(cpElements)
    .where(eq(cpElements.curriculumVersionId, version.id));
  const topicRows = await db
    .select()
    .from(topics)
    .where(eq(topics.curriculumVersionId, version.id));
  const objectives = topicRows.length
    ? await db
        .select()
        .from(learningObjectives)
        .where(
          inArray(
            learningObjectives.topicId,
            topicRows.map((t) => t.id),
          ),
        )
    : [];
  return canonicalizeStored({
    version: {
      code: version.code,
      title: version.title,
      sourceTitle: version.sourceTitle,
      sourceUrl: version.sourceUrl,
      decreeRef: version.decreeRef,
      publishedOn: version.publishedOn,
      retrievedOn: version.retrievedOn,
    },
    elements: elements.map((e) => ({
      id: e.id,
      code: e.code,
      name: e.name,
      outcomeText: e.outcomeText,
    })),
    topics: topicRows.map((t) => ({
      id: t.id,
      elementId: t.cpElementId,
      grade: t.grade,
      stableKey: t.stableKey,
      title: t.title,
      scopeNotes: t.scopeNotes,
      sourceRef: t.sourceRef,
      sortOrder: t.sortOrder,
    })),
    objectives: objectives.map((o) => ({
      topicId: o.topicId,
      code: o.code,
      text: o.text,
      sourceRef: o.sourceRef,
    })),
  });
}

async function activate(db: AnyDb, versionId: string): Promise<string[]> {
  const others = await db
    .select({ id: curriculumVersions.id, code: curriculumVersions.code })
    .from(curriculumVersions)
    .where(eq(curriculumVersions.status, "active"));
  const toArchive = others.filter((v) => v.id !== versionId);
  if (toArchive.length > 0) {
    await db
      .update(curriculumVersions)
      .set({ status: "archived" })
      .where(
        inArray(
          curriculumVersions.id,
          toArchive.map((v) => v.id),
        ),
      );
  }
  await db
    .update(curriculumVersions)
    .set({ status: "active" })
    .where(eq(curriculumVersions.id, versionId));
  return toArchive.map((v) => v.code);
}

async function apply(
  db: AnyDb,
  seed: CurriculumSeed,
  options: WriteSeedOptions,
): Promise<WriteSeedResult> {
  const created = zero();
  const updated = zero();
  const deleted = zero();
  const code = seed.version.code;

  const existing = (
    await db
      .select()
      .from(curriculumVersions)
      .where(eq(curriculumVersions.code, code))
      .limit(1)
  ).at(0);

  const result = (
    versionStatus: WriteSeedResult["versionStatus"],
    extra: { activated: boolean; archivedVersions: string[] },
  ): WriteSeedResult => ({
    versionCode: code,
    versionStatus,
    created,
    updated,
    deleted,
    activated: extra.activated,
    archivedVersions: extra.archivedVersions,
    unchanged:
      isEmpty(created) &&
      isEmpty(updated) &&
      isEmpty(deleted) &&
      !extra.activated &&
      extra.archivedVersions.length === 0,
  });

  // An activated (or archived) version is immutable: identical content is a no-op, anything else is
  // refused so saved questions are never affected (CUR-05).
  if (existing && existing.status !== "draft") {
    if ((await readStored(db, existing)) !== canonicalizeSeed(seed)) {
      throw new SeedConflictError(
        `Versi kurikulum "${code}" sudah ${existing.status === "active" ? "aktif" : "diarsipkan"} dan isinya berbeda dari berkas seed. ` +
          "Versi yang sudah diaktifkan tidak boleh diubah: naikkan kode versi (misalnya -v2) untuk membuat versi baru.",
      );
    }
    if (options.activate && existing.status === "archived") {
      throw new SeedConflictError(
        `Versi kurikulum "${code}" sudah diarsipkan dan tidak dapat diaktifkan kembali. Muat versi baru dengan kode versi yang baru.`,
      );
    }
    return result(existing.status as WriteSeedResult["versionStatus"], {
      activated: false,
      archivedVersions: [],
    });
  }

  // Version row.
  let versionId: string;
  if (!existing) {
    const [row] = await db
      .insert(curriculumVersions)
      .values({
        code,
        title: seed.version.title,
        sourceTitle: seed.version.sourceTitle,
        sourceUrl: seed.version.sourceUrl,
        decreeRef: seed.version.decreeRef ?? null,
        publishedOn: seed.version.publishedOn,
        retrievedOn: seed.version.retrievedOn,
        status: "draft",
      })
      .returning({ id: curriculumVersions.id });
    versionId = row.id;
    created.versions += 1;
  } else {
    versionId = existing.id;
    const next = {
      title: seed.version.title,
      sourceTitle: seed.version.sourceTitle,
      sourceUrl: seed.version.sourceUrl,
      decreeRef: seed.version.decreeRef ?? null,
      publishedOn: seed.version.publishedOn,
      retrievedOn: seed.version.retrievedOn,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).some(
      (key) => existing[key] !== next[key],
    );
    if (changed) {
      await db
        .update(curriculumVersions)
        .set(next)
        .where(eq(curriculumVersions.id, versionId));
      updated.versions += 1;
    }
  }

  // Elements.
  const storedElements = await db
    .select()
    .from(cpElements)
    .where(eq(cpElements.curriculumVersionId, versionId));
  const elementByCode = new Map(storedElements.map((e) => [e.code, e]));
  const elementIds = new Map<string, string>();
  for (const element of seed.elements) {
    const found = elementByCode.get(element.code);
    if (!found) {
      const [row] = await db
        .insert(cpElements)
        .values({
          curriculumVersionId: versionId,
          code: element.code,
          name: element.name,
          outcomeText: element.outcomeText,
        })
        .returning({ id: cpElements.id });
      elementIds.set(element.code, row.id);
      created.elements += 1;
    } else {
      elementIds.set(element.code, found.id);
      if (found.name !== element.name || found.outcomeText !== element.outcomeText) {
        await db
          .update(cpElements)
          .set({ name: element.name, outcomeText: element.outcomeText })
          .where(eq(cpElements.id, found.id));
        updated.elements += 1;
      }
    }
  }

  // Topics and their objectives.
  const storedTopics = await db
    .select()
    .from(topics)
    .where(eq(topics.curriculumVersionId, versionId));
  const topicByKey = new Map(
    storedTopics.map((t) => [`${String(t.grade)}:${t.stableKey}`, t]),
  );
  const seedTopicKeys = new Set(
    seed.topics.map((t) => `${String(t.grade)}:${t.stableKey}`),
  );

  for (const topic of seed.topics) {
    const elementId = elementIds.get(topic.elementCode);
    if (!elementId) {
      throw new Error(
        `Topik ${topic.stableKey} merujuk ke elemen yang tidak ada: ${topic.elementCode}`,
      );
    }
    const key = `${String(topic.grade)}:${topic.stableKey}`;
    const found = topicByKey.get(key);
    let topicId: string;
    if (!found) {
      const [row] = await db
        .insert(topics)
        .values({
          curriculumVersionId: versionId,
          cpElementId: elementId,
          grade: topic.grade,
          stableKey: topic.stableKey,
          title: topic.title,
          scopeNotes: topic.scopeNotes,
          sourceRef: topic.sourceRef,
          sortOrder: topic.sortOrder,
        })
        .returning({ id: topics.id });
      topicId = row.id;
      created.topics += 1;
    } else {
      topicId = found.id;
      const differs =
        found.cpElementId !== elementId ||
        found.title !== topic.title ||
        found.scopeNotes !== topic.scopeNotes ||
        found.sourceRef !== topic.sourceRef ||
        found.sortOrder !== topic.sortOrder;
      if (differs) {
        await db
          .update(topics)
          .set({
            cpElementId: elementId,
            title: topic.title,
            scopeNotes: topic.scopeNotes,
            sourceRef: topic.sourceRef,
            sortOrder: topic.sortOrder,
          })
          .where(eq(topics.id, topicId));
        updated.topics += 1;
      }
    }

    const storedObjectives = found
      ? await db
          .select()
          .from(learningObjectives)
          .where(eq(learningObjectives.topicId, topicId))
      : [];
    const objectiveByCode = new Map(storedObjectives.map((o) => [o.code, o]));
    const seedCodes = new Set(topic.objectives.map((o) => o.code));
    for (const objective of topic.objectives) {
      const existingObjective = objectiveByCode.get(objective.code);
      if (!existingObjective) {
        await db.insert(learningObjectives).values({
          topicId,
          code: objective.code,
          text: objective.text,
          sourceRef: objective.sourceRef,
        });
        created.objectives += 1;
      } else if (
        existingObjective.text !== objective.text ||
        existingObjective.sourceRef !== objective.sourceRef
      ) {
        await db
          .update(learningObjectives)
          .set({ text: objective.text, sourceRef: objective.sourceRef })
          .where(eq(learningObjectives.id, existingObjective.id));
        updated.objectives += 1;
      }
    }
    const staleObjectives = storedObjectives.filter((o) => !seedCodes.has(o.code));
    if (staleObjectives.length > 0) {
      await db.delete(learningObjectives).where(
        inArray(
          learningObjectives.id,
          staleObjectives.map((o) => o.id),
        ),
      );
      deleted.objectives += staleObjectives.length;
    }
  }

  // Topics no longer in the seed (objectives go with them), then elements no longer in the seed.
  const staleTopics = storedTopics.filter(
    (t) => !seedTopicKeys.has(`${String(t.grade)}:${t.stableKey}`),
  );
  if (staleTopics.length > 0) {
    const staleIds = staleTopics.map((t) => t.id);
    const orphaned = await db
      .select({ id: learningObjectives.id })
      .from(learningObjectives)
      .where(inArray(learningObjectives.topicId, staleIds));
    deleted.objectives += orphaned.length;
    await db
      .delete(learningObjectives)
      .where(inArray(learningObjectives.topicId, staleIds));
    await db.delete(topics).where(inArray(topics.id, staleIds));
    deleted.topics += staleTopics.length;
  }
  const seedElementCodes = new Set(seed.elements.map((e) => e.code));
  const staleElements = storedElements.filter((e) => !seedElementCodes.has(e.code));
  if (staleElements.length > 0) {
    await db.delete(cpElements).where(
      inArray(
        cpElements.id,
        staleElements.map((e) => e.id),
      ),
    );
    deleted.elements += staleElements.length;
  }

  // Activation.
  let activated = false;
  let archivedVersions: string[] = [];
  let status: WriteSeedResult["versionStatus"] = "draft";
  if (options.activate) {
    archivedVersions = await activate(db, versionId);
    activated = true;
    status = "active";
  }
  return result(status, { activated, archivedVersions });
}

// Writes a validated seed in one transaction on the service connection. The seed must already have
// passed validateSeed (the loader and the CLI do that). A dry run performs the whole write and rolls
// it back, returning the same result.
export async function writeSeed<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  seed: CurriculumSeed,
  options: WriteSeedOptions,
): Promise<WriteSeedResult> {
  try {
    return await db.transaction(async (tx) => {
      const result = await apply(tx, seed, options);
      if (options.dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}
