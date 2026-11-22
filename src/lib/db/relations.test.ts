import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE, seedFixtures } from "./test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "./test-harness";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedFixtures(database.db);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

describe("relational queries (RQB v2)", () => {
  it("loads a user with their profile, and a job with its runs", async () => {
    const user = await database.db.query.user.findFirst({
      where: { id: USER_A },
      with: { profile: true },
    });
    expect(user?.profile?.id).toBe(USER_A);

    const job = await database.db.query.jobs.findFirst({
      where: { id: FIXTURE.job(1) },
      with: { runs: true, owner: true },
    });
    expect(job?.runs.map((r) => r.id)).toEqual([FIXTURE.jobRun(1)]);
    expect(job?.owner.id).toBe(USER_A);
  });

  it("loads a question with its versions", async () => {
    const question = await database.db.query.questions.findFirst({
      where: { id: FIXTURE.question(1) },
      with: { versions: true },
    });
    expect(question?.versions.map((v) => v.id)).toEqual([FIXTURE.version(1)]);
  });

  it("loads an assessment with its template, sections, pinned items and exports", async () => {
    const assessment = await database.db.query.assessments.findFirst({
      where: { id: FIXTURE.assessment(1) },
      with: {
        template: true,
        sections: { with: { items: { with: { version: true } } } },
        exports: true,
      },
    });
    expect(assessment?.template?.id).toBe(FIXTURE.template(1));
    expect(assessment?.sections.map((s) => s.items.map((i) => i.version.id))).toEqual([
      [FIXTURE.version(1)],
    ]);
    expect(assessment?.exports.map((e) => e.id)).toEqual([FIXTURE.export(1)]);
  });

  it("loads a material with its folder, sections and pages, and a solver session with its solutions", async () => {
    const material = await database.db.query.materials.findFirst({
      where: { id: FIXTURE.material(1) },
      with: { folder: true, sections: true, pages: true },
    });
    expect(material?.folder?.id).toBe(FIXTURE.folder(1));
    expect(material?.sections.map((s) => s.id)).toEqual([FIXTURE.materialSection(1)]);
    expect(material?.pages.map((p) => p.id)).toEqual([FIXTURE.materialPage(1)]);

    const session = await database.db.query.solverSessions.findFirst({
      where: { id: FIXTURE.solverSession(1) },
      with: { solutions: true },
    });
    expect(session?.solutions.map((s) => s.id)).toEqual([FIXTURE.solverSolution(1)]);
  });
});
