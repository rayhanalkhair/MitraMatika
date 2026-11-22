import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cpElements,
  curriculumVersions,
  learningObjectives,
  topics,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { loadGrade8SeedV1 } from "./load-seed";
import type { CurriculumSeed } from "../schema/seed-schema";
import { SeedConflictError, writeSeed } from "./seed-writer";

let database: TestDatabase;

const makeSeed = (code = "test-v1"): CurriculumSeed => ({
  version: {
    code,
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
        { code: "TP-1", text: "Satu", sourceRef: "r" },
        { code: "TP-2", text: "Dua", sourceRef: "r" },
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

const write = (seed: CurriculumSeed, activate = false, dryRun = false) =>
  writeSeed(database.db, seed, { activate, dryRun });

const counts = async () => ({
  versions: (await database.db.select().from(curriculumVersions)).length,
  elements: (await database.db.select().from(cpElements)).length,
  topics: (await database.db.select().from(topics)).length,
  objectives: (await database.db.select().from(learningObjectives)).length,
});

const topicIds = async () =>
  Object.fromEntries(
    (await database.db.select().from(topics)).map((t) => [t.stableKey, t.id]),
  );

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

beforeEach(async () => {
  await database.db.delete(learningObjectives);
  await database.db.delete(topics);
  await database.db.delete(cpElements);
  await database.db.delete(curriculumVersions);
});

describe("writeSeed: a new version", () => {
  it("inserts it as a draft with the right counts", async () => {
    const result = await write(makeSeed());
    expect(result).toMatchObject({
      versionCode: "test-v1",
      versionStatus: "draft",
      activated: false,
      unchanged: false,
      archivedVersions: [],
      created: { versions: 1, elements: 2, topics: 2, objectives: 3 },
      updated: { versions: 0, elements: 0, topics: 0, objectives: 0 },
      deleted: { versions: 0, elements: 0, topics: 0, objectives: 0 },
    });
    expect(await counts()).toEqual({
      versions: 1,
      elements: 2,
      topics: 2,
      objectives: 3,
    });
  });

  it("links topics to their element and stores the seed fields", async () => {
    await write(makeSeed());
    const [topic] = await database.db
      .select({ title: topics.title, element: cpElements.code, order: topics.sortOrder })
      .from(topics)
      .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
      .where(eq(topics.stableKey, "spldv"));
    expect(topic).toEqual({ title: "SPLDV", element: "aljabar", order: 2 });
  });

  it("loads the real Grade 8 seed file", async () => {
    const result = await write(loadGrade8SeedV1());
    expect(result.created).toEqual({
      versions: 1,
      elements: 5,
      topics: 8,
      objectives: 16,
    });
    expect(result.versionStatus).toBe("draft");
  });
});

describe("writeSeed: re-loading a draft", () => {
  it("is a no-op when nothing changed and keeps the row ids", async () => {
    await write(makeSeed());
    const before = await topicIds();
    const result = await write(makeSeed());
    expect(result.unchanged).toBe(true);
    expect(result.created).toEqual({
      versions: 0,
      elements: 0,
      topics: 0,
      objectives: 0,
    });
    expect(result.updated).toEqual({
      versions: 0,
      elements: 0,
      topics: 0,
      objectives: 0,
    });
    expect(result.deleted).toEqual({
      versions: 0,
      elements: 0,
      topics: 0,
      objectives: 0,
    });
    expect(await topicIds()).toEqual(before);
  });

  it("updates edited fields in place with the same ids", async () => {
    await write(makeSeed());
    const before = await topicIds();
    const edited = makeSeed();
    edited.topics[0].title = "Pangkat dan Akar";
    edited.topics[0].objectives[0].text = "Satu (revisi)";
    edited.elements[1].name = "Aljabar Dasar";
    edited.version.title = "Test revisi";
    const result = await write(edited);
    expect(result.unchanged).toBe(false);
    expect(result.updated).toEqual({
      versions: 1,
      elements: 1,
      topics: 1,
      objectives: 1,
    });
    expect(await topicIds()).toEqual(before);
    const row = (
      await database.db.select().from(topics).where(eq(topics.stableKey, "pangkat"))
    ).at(0);
    expect(row?.title).toBe("Pangkat dan Akar");
  });

  it("inserts a new topic and its objectives", async () => {
    await write(makeSeed());
    const grown = makeSeed();
    grown.topics.push({
      stableKey: "teorema-pythagoras",
      grade: 8,
      elementCode: "geometri",
      title: "Pythagoras",
      scopeNotes: "Catatan",
      sourceRef: "ref-3",
      sortOrder: 3,
      objectives: [
        { code: "TP-4", text: "Empat", sourceRef: "r" },
        { code: "TP-5", text: "Lima", sourceRef: "r" },
      ],
    });
    grown.elements.push({
      code: "geometri",
      name: "Geometri",
      outcomeText: "CP geometri",
    });
    const result = await write(grown);
    expect(result.created).toEqual({
      versions: 0,
      elements: 1,
      topics: 1,
      objectives: 2,
    });
    expect(await counts()).toEqual({
      versions: 1,
      elements: 3,
      topics: 3,
      objectives: 5,
    });
  });

  it("keeps a topic moved to another element when its old element is removed", async () => {
    await write(makeSeed());
    const before = await topicIds();
    const moved = makeSeed();
    moved.topics[1].elementCode = "bilangan"; // spldv leaves aljabar
    moved.elements.pop(); // aljabar is gone from the seed
    const result = await write(moved);
    // Elements are deleted after topics were re-pointed, so the element -> topic cascade spares it.
    expect(await topicIds()).toEqual(before);
    expect(await counts()).toEqual({
      versions: 1,
      elements: 1,
      topics: 2,
      objectives: 3,
    });
    expect(result.deleted).toEqual({
      versions: 0,
      elements: 1,
      topics: 0,
      objectives: 0,
    });
  });

  it("deletes a removed objective, a removed topic (with its objectives) and a removed element", async () => {
    await write(makeSeed());
    const shrunk = makeSeed();
    shrunk.topics[0].objectives.pop(); // removes TP-2
    shrunk.topics.pop(); // removes spldv (1 objective)
    shrunk.elements.pop(); // removes aljabar
    const result = await write(shrunk);
    expect(result.deleted).toEqual({
      versions: 0,
      elements: 1,
      topics: 1,
      objectives: 2,
    });
    expect(await counts()).toEqual({
      versions: 1,
      elements: 1,
      topics: 1,
      objectives: 1,
    });
  });
});

describe("writeSeed: activation", () => {
  it("activates a new version when asked", async () => {
    const result = await write(makeSeed(), true);
    expect(result).toMatchObject({
      versionStatus: "active",
      activated: true,
      archivedVersions: [],
    });
  });

  it("activates a loaded draft later without changing its content", async () => {
    await write(makeSeed());
    const result = await write(makeSeed(), true);
    expect(result).toMatchObject({ versionStatus: "active", activated: true });
    expect(result.unchanged).toBe(false);
    const none = { versions: 0, elements: 0, topics: 0, objectives: 0 };
    expect(result.created).toEqual(none);
    expect(result.updated).toEqual(none);
    expect(result.deleted).toEqual(none);
  });

  it("archives the previously active version in the same transaction", async () => {
    await write(makeSeed("test-v1"), true);
    const result = await write(makeSeed("test-v2"), true);
    expect(result).toMatchObject({
      versionStatus: "active",
      activated: true,
      archivedVersions: ["test-v1"],
    });
    const rows = await database.db.select().from(curriculumVersions);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.status]))).toEqual({
      "test-v1": "archived",
      "test-v2": "active",
    });
  });

  it("leaves other versions alone when activate is false", async () => {
    await write(makeSeed("test-v1"), true);
    await write(makeSeed("test-v2"), false);
    const rows = await database.db.select().from(curriculumVersions);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.status]))).toEqual({
      "test-v1": "active",
      "test-v2": "draft",
    });
  });
});

describe("writeSeed: activated versions are immutable", () => {
  it("is a no-op for identical content, with or without activate", async () => {
    await write(makeSeed(), true);
    expect((await write(makeSeed(), false)).unchanged).toBe(true);
    expect((await write(makeSeed(), true)).unchanged).toBe(true);
  });

  it("refuses changed content and changes nothing", async () => {
    await write(makeSeed(), true);
    const changed = makeSeed();
    changed.topics[0].title = "Diubah";
    await expect(write(changed)).rejects.toBeInstanceOf(SeedConflictError);
    await expect(write(changed)).rejects.toThrow(/kode versi/i);
    const row = (
      await database.db.select().from(topics).where(eq(topics.stableKey, "pangkat"))
    ).at(0);
    expect(row?.title).toBe("Pangkat");
  });

  it("refuses to activate an archived version", async () => {
    await write(makeSeed("test-v1"), true);
    await write(makeSeed("test-v2"), true); // archives test-v1
    await expect(write(makeSeed("test-v1"), true)).rejects.toBeInstanceOf(
      SeedConflictError,
    );
  });
});

describe("writeSeed: dry run and failure", () => {
  it("reports the counts of a new version without writing anything", async () => {
    const result = await write(makeSeed(), false, true);
    expect(result.created).toEqual({
      versions: 1,
      elements: 2,
      topics: 2,
      objectives: 3,
    });
    expect(await counts()).toEqual({
      versions: 0,
      elements: 0,
      topics: 0,
      objectives: 0,
    });
  });

  it("reports the changes to a draft without applying them", async () => {
    await write(makeSeed());
    const edited = makeSeed();
    edited.topics[0].title = "Diubah";
    const result = await write(edited, false, true);
    expect(result.updated.topics).toBe(1);
    const row = (
      await database.db.select().from(topics).where(eq(topics.stableKey, "pangkat"))
    ).at(0);
    expect(row?.title).toBe("Pangkat");
  });

  it("rolls the whole write back when a topic names a missing element", async () => {
    const broken = makeSeed();
    broken.topics[1].elementCode = "tidak-ada";
    await expect(write(broken)).rejects.toThrow(/tidak-ada/);
    expect(await counts()).toEqual({
      versions: 0,
      elements: 0,
      topics: 0,
      objectives: 0,
    });
  });
});
