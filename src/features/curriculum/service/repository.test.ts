import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import {
  cpElements,
  curriculumVersions,
  learningObjectives,
  topics,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import type { CurriculumSeed } from "../schema/seed-schema";
import { createCurriculumRepository } from "./repository";
import { writeSeed } from "./seed-writer";

let database: TestDatabase;

const makeSeed = (
  code: string,
  titles: [string, string] = ["Pangkat", "SPLDV"],
): CurriculumSeed => ({
  version: {
    code,
    title: `Versi ${code}`,
    sourceTitle: "Sumber",
    sourceUrl: "https://example.test/s",
    decreeRef: "SK 1/2025",
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
      title: titles[0],
      scopeNotes: "Catatan pangkat",
      sourceRef: "ref-1",
      sortOrder: 2,
      objectives: [
        { code: "TP-2", text: "Dua", sourceRef: "r2" },
        { code: "TP-1", text: "Satu", sourceRef: "r1" },
      ],
    },
    {
      stableKey: "spldv",
      grade: 8,
      elementCode: "aljabar",
      title: titles[1],
      scopeNotes: "Catatan spldv",
      sourceRef: "ref-2",
      sortOrder: 1,
      objectives: [{ code: "TP-3", text: "Tiga", sourceRef: "r3" }],
    },
    {
      stableKey: "fungsi",
      grade: 9,
      elementCode: "aljabar",
      title: "Fungsi Kuadrat",
      scopeNotes: "Catatan",
      sourceRef: "ref-3",
      sortOrder: 1,
      objectives: [{ code: "TP-9", text: "Sembilan", sourceRef: "r9" }],
    },
  ],
});

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

const repo = () => createCurriculumRepository(database.db);

describe("getActiveVersion", () => {
  it("returns null when there is no active version", async () => {
    expect(await repo().getActiveVersion()).toBeNull();
    await writeSeed(database.db, makeSeed("v1"), { activate: false }); // draft only
    expect(await repo().getActiveVersion()).toBeNull();
  });

  it("returns the active version's metadata", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    expect(await repo().getActiveVersion()).toEqual({
      id: expect.any(String) as unknown,
      code: "v1",
      title: "Versi v1",
      sourceTitle: "Sumber",
      sourceUrl: "https://example.test/s",
      decreeRef: "SK 1/2025",
      publishedOn: "2025-07-16",
      retrievedOn: "2026-09-23",
    });
  });

  it("prefers the newest published version if more than one is active (defensive)", async () => {
    // v1 is published 2025-07-16 and created first; v2 is created later but published earlier,
    // so publishedOn (not createdAt) must decide.
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const second = makeSeed("v2");
    second.version.publishedOn = "2024-01-01";
    await writeSeed(database.db, second, { activate: false });
    // Force the unexpected state the writer itself never produces.
    await database.db.execute(
      sql.raw(`update curriculum_versions set status = 'active' where code = 'v2'`),
    );
    expect((await repo().getActiveVersion())?.code).toBe("v1");
  });
});

describe("listTopics", () => {
  it("returns nothing while the version is a draft", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: false });
    expect(await repo().listTopics(8)).toEqual([]);
  });

  it("returns the grade's topics ordered by sort order, with their element", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const list = await repo().listTopics(8);
    expect(list.map((t) => t.stableKey)).toEqual(["spldv", "pangkat"]);
    expect(list[0]).toEqual({
      id: expect.any(String) as unknown,
      stableKey: "spldv",
      grade: 8,
      title: "SPLDV",
      scopeNotes: "Catatan spldv",
      sortOrder: 1,
      element: { code: "aljabar", name: "Aljabar" },
    });
  });

  it("filters by grade and returns [] for a grade with no topics", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    expect((await repo().listTopics(9)).map((t) => t.stableKey)).toEqual(["fungsi"]);
    expect(await repo().listTopics(7)).toEqual([]);
  });

  it("does not mix in the topics of a draft version loaded later", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: false,
    });
    const titles = (await repo().listTopics(8)).map((t) => t.title);
    expect(titles).toEqual(["SPLDV", "Pangkat"]);
  });

  it("switches to the new version once it is activated", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: true,
    });
    expect((await repo().listTopics(8)).map((t) => t.title)).toEqual([
      "SPLDV baru",
      "Pangkat baru",
    ]);
  });
});

describe("getTopic", () => {
  beforeEach(async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
  });

  it("finds a topic by grade and stable key with its element, objectives and version", async () => {
    const topic = await repo().getTopic({ grade: 8, stableKey: "pangkat" });
    expect(topic).toMatchObject({
      stableKey: "pangkat",
      grade: 8,
      title: "Pangkat",
      sourceRef: "ref-1",
      element: { code: "bilangan", name: "Bilangan", outcomeText: "CP bilangan" },
      version: { code: "v1", sourceTitle: "Sumber" },
    });
    expect(topic?.objectives.map((o) => o.code)).toEqual(["TP-1", "TP-2"]);
    expect(topic?.objectives[0]).toEqual({
      id: expect.any(String) as unknown,
      code: "TP-1",
      text: "Satu",
      sourceRef: "r1",
    });
  });

  it("finds the same topic by id", async () => {
    const byKey = await repo().getTopic({ grade: 8, stableKey: "spldv" });
    const byId = await repo().getTopic({ id: byKey!.id });
    expect(byId).toEqual(byKey);
  });

  it("returns null for an unknown key, a wrong grade or an unknown id", async () => {
    expect(await repo().getTopic({ grade: 8, stableKey: "tidak-ada" })).toBeNull();
    expect(await repo().getTopic({ grade: 7, stableKey: "pangkat" })).toBeNull();
    expect(
      await repo().getTopic({ id: "00000000-0000-4000-8000-000000000000" }),
    ).toBeNull();
  });

  it("returns null for an id that is not a UUID instead of raising a database error", async () => {
    expect(await repo().getTopic({ id: "bukan-uuid" })).toBeNull();
    expect(await repo().getTopic({ id: "" })).toBeNull();
  });

  it("returns null for a topic of a draft version", async () => {
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: false,
    });
    const draftTopic = (await database.db.select().from(topics)).find(
      (t) => t.title === "Pangkat baru",
    );
    expect(await repo().getTopic({ id: draftTopic!.id })).toBeNull();
  });

  it("returns null for a topic of an archived version", async () => {
    const v1Topic = await repo().getTopic({ grade: 8, stableKey: "pangkat" });
    expect(v1Topic).not.toBeNull();
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: true,
    });
    expect(await repo().getTopic({ id: v1Topic!.id })).toBeNull();
  });
});

describe("under row level security", () => {
  it("lets a teacher read the active catalogue through runAsUser", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const topicsSeen = await runAsUser(database.db, USER_A, (tx) =>
      createCurriculumRepository(tx).listTopics(8),
    );
    expect(topicsSeen.map((t) => t.stableKey)).toEqual(["spldv", "pangkat"]);
  });

  it("does not let a teacher write the catalogue", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    let failure = "";
    try {
      await runAsUser(database.db, USER_A, (tx) =>
        tx.update(curriculumVersions).set({ title: "diubah" }),
      );
    } catch (error) {
      // Drizzle wraps the real Postgres error, so match against the whole cause chain.
      const parts: string[] = [];
      for (let e: unknown = error; e instanceof Error; e = e.cause) parts.push(e.message);
      failure = parts.join(" | ");
    }
    expect(failure).toMatch(/permission denied/i);
    const [row] = await database.db.select().from(curriculumVersions);
    expect(row.title).toBe("Versi v1");
  });
});

describe("listTopicsWithObjectives", () => {
  it("returns the grade's topics with their objectives, in listTopics order", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const withObjectives = await repo().listTopicsWithObjectives(8);
    const summaries = await repo().listTopics(8);
    expect(withObjectives.map((t) => t.stableKey)).toEqual(
      summaries.map((t) => t.stableKey),
    );
    const pangkat = withObjectives.find((t) => t.stableKey === "pangkat");
    expect(pangkat).toMatchObject({
      title: "Pangkat",
      sourceRef: "ref-1",
      element: { code: "bilangan", name: "Bilangan" },
    });
    expect(pangkat?.objectives.map((o) => o.code)).toEqual(["TP-1", "TP-2"]);
    expect(pangkat?.objectives[0]).toEqual({
      id: expect.any(String) as unknown,
      code: "TP-1",
      text: "Satu",
      sourceRef: "r1",
    });
  });

  it("gives each topic only its own objectives", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const list = await repo().listTopicsWithObjectives(8);
    expect(
      list.find((t) => t.stableKey === "spldv")?.objectives.map((o) => o.code),
    ).toEqual(["TP-3"]);
  });

  it("returns [] for a grade with no topics and while only a draft exists", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: false });
    expect(await repo().listTopicsWithObjectives(8)).toEqual([]);
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    expect(await repo().listTopicsWithObjectives(7)).toEqual([]);
  });

  it("is readable as a teacher through runAsUser", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const list = await runAsUser(database.db, USER_A, (tx) =>
      createCurriculumRepository(tx).listTopicsWithObjectives(8),
    );
    expect(list).toHaveLength(2);
  });

  it("does not mix in the topics of a draft version loaded later", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: false,
    });
    const list = await repo().listTopicsWithObjectives(8);
    expect(list.map((t) => t.title)).toEqual(["SPLDV", "Pangkat"]);
    expect(list.flatMap((t) => t.objectives.map((o) => o.code)).sort()).toEqual([
      "TP-1",
      "TP-2",
      "TP-3",
    ]);
  });
});

describe("getTopicInVersion", () => {
  it("reads a topic of a version that is no longer active", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const old = await repo().getTopic({ grade: 8, stableKey: "spldv" });
    await writeSeed(database.db, makeSeed("v2", ["Pangkat baru", "SPLDV baru"]), {
      activate: true,
    });

    expect(await repo().getTopic({ id: old!.id })).toBeNull(); // v1 is archived now
    const found = await repo().getTopicInVersion(old!.id, old!.version.id);
    expect(found).toMatchObject({
      id: old!.id,
      stableKey: "spldv",
      title: "SPLDV",
      sourceRef: "ref-2",
      version: { code: "v1" },
      objectives: [{ code: "TP-3", text: "Tiga" }],
    });
  });

  it("returns null when the topic belongs to another version", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const old = await repo().getTopic({ grade: 8, stableKey: "spldv" });
    await writeSeed(database.db, makeSeed("v2"), { activate: true });
    const current = await repo().getTopic({ grade: 8, stableKey: "spldv" });
    expect(await repo().getTopicInVersion(current!.id, old!.version.id)).toBeNull();
  });

  it("returns null for ids that are not UUIDs or are unknown", async () => {
    await writeSeed(database.db, makeSeed("v1"), { activate: true });
    const topic = await repo().getTopic({ grade: 8, stableKey: "spldv" });
    expect(await repo().getTopicInVersion("nope", topic!.version.id)).toBeNull();
    expect(await repo().getTopicInVersion(topic!.id, "nope")).toBeNull();
    expect(
      await repo().getTopicInVersion(
        "99999999-9999-4999-8999-999999999999",
        topic!.version.id,
      ),
    ).toBeNull();
  });
});
