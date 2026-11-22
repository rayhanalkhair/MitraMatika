import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import {
  assessments,
  exports,
  folders,
  generationRequests,
  jobs,
  materials,
  materialUploads,
  ocrUsage,
  questionSources,
  schoolTemplates,
  solverSessions,
} from "@/lib/db/schema";
import { SCENARIOS, type Scenario } from "./control";
import { logger } from "@/lib/logger";

const NO_STORE = { "Cache-Control": "no-store" };

export interface ControlRouteDeps {
  // isFakeAiEnabled in production wiring: evaluated before anything else.
  enabled: () => boolean;
  setScenario: (scenario: Scenario) => void;
  resetAi: () => void;
  // Makes the fake user's deferred jobs due and returns how many it touched.
  expedite: () => Promise<number>;
  runJobs: () => Promise<unknown>;
  // Moves the fake user's generation requests of the last day back one day (rows kept), so the
  // next scenario starts with a clean daily budget; returns how many it moved.
  resetDailyUsage: () => Promise<number>;
  // Uses up the fake user's whole daily budget (the daily-limit e2e).
  fillDailyUsage: () => Promise<void>;
  // Deletes the fake user's assessments, templates, export rows and export jobs (and their
  // stored files), so every assessment spec starts from none; returns the counts.
  resetAssessments: () => Promise<AssessmentReset>;
  // Deletes the fake user's materials, folders, upload reservations and OCR usage (and their
  // stored files), so every materials spec starts from an empty library and a full daily cap.
  resetMaterials: () => Promise<MaterialReset>;
  // Deletes the fake user's solver sessions (and their photos) and gives back the day's solves.
  resetSolver: () => Promise<SolverReset>;
}

export interface MaterialReset {
  materials: number;
  folders: number;
  uploads: number;
  jobs: number;
}

export interface SolverReset {
  sessions: number;
  jobs: number;
}

export interface AssessmentReset {
  assessments: number;
  templates: number;
  exportJobs: number;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: NO_STORE });

const badRequest = () => json({ error: "bad_request" }, 400);

export async function handleControlRequest(
  request: Request,
  deps: ControlRouteDeps,
): Promise<Response> {
  // The gate comes first: off means a 404 like an unknown route (POST; other methods get Next's own 405, and the proxy guards the route anyway).
  if (!deps.enabled()) return new Response(null, { status: 404 });
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest();
  }
  const keys = Object.keys(body);
  if (keys.length !== 1) return badRequest();
  const record = body as Record<string, unknown>;

  if (keys[0] === "scenario") {
    const scenario = record.scenario;
    if (
      typeof scenario !== "string" ||
      !(SCENARIOS as readonly string[]).includes(scenario)
    ) {
      return badRequest();
    }
    deps.resetAi();
    deps.setScenario(scenario as Scenario);
    return json({ ok: true });
  }
  if (keys[0] === "reset" && record.reset === true) {
    deps.resetAi();
    return json({ ok: true });
  }
  if (keys[0] === "expedite" && record.expedite === true) {
    try {
      const resumed = await deps.expedite();
      await deps.runJobs();
      return json({ ok: true, resumed });
    } catch (error) {
      logger.error(
        { module: "e2e-control", code: (error as { code?: unknown } | null)?.code ?? "" },
        "e2e control: expedite failed",
      );
      return json({ error: "unavailable" }, 500);
    }
  }
  if (keys[0] === "resetDailyUsage" && record.resetDailyUsage === true) {
    return dailyUsage(async () => ({ moved: await deps.resetDailyUsage() }));
  }
  if (keys[0] === "fillDailyUsage" && record.fillDailyUsage === true) {
    return dailyUsage(async () => {
      await deps.fillDailyUsage();
      return {};
    });
  }
  if (keys[0] === "resetAssessments" && record.resetAssessments === true) {
    return dataChange(
      async () => ({ ...(await deps.resetAssessments()) }),
      "e2e control: assessment reset failed",
    );
  }
  if (keys[0] === "resetMaterials" && record.resetMaterials === true) {
    return dataChange(
      async () => ({ ...(await deps.resetMaterials()) }),
      "e2e control: materials reset failed",
    );
  }
  if (keys[0] === "resetSolver" && record.resetSolver === true) {
    return dataChange(
      async () => ({ ...(await deps.resetSolver()) }),
      "e2e control: solver reset failed",
    );
  }
  return badRequest();
}

function dailyUsage(run: () => Promise<Record<string, unknown>>): Promise<Response> {
  return dataChange(run, "e2e control: daily usage change failed");
}

async function dataChange(
  run: () => Promise<Record<string, unknown>>,
  failure: string,
): Promise<Response> {
  try {
    return json({ ok: true, ...(await run()) });
  } catch (error) {
    logger.error(
      { module: "e2e-control", code: (error as { code?: unknown } | null)?.code ?? "" },
      failure,
    );
    return json({ error: "unavailable" }, 500);
  }
}

// Service connection (RLS bypassed): the owner filter is explicit and the status filter keeps
// queued/running/finished jobs untouched.
export async function expediteDeferredJobs<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, ownerId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ runAfter: sql`now()` })
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.status, "deferred")))
    .returning({ id: jobs.id });
  return rows.length;
}

// The single-question regeneration job, counted toward the daily limit (src/lib cannot import the
// feature's REGENERATE_JOB_TYPE).
const REGENERATE_JOB_TYPE = "regenerate_question";

// Service connection (RLS bypassed), explicit owner filter. Every request and regeneration job
// created in the last 24 h moves back one day, which puts it before the start of today's
// Asia/Jakarta window; the rows stay. Returns how many rows moved.
export async function rewindDailyUsage<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, ownerId: string): Promise<number> {
  const regenerations = await db
    .update(jobs)
    .set({ createdAt: sql`${jobs.createdAt} - interval '1 day'` })
    .where(
      and(
        eq(jobs.ownerId, ownerId),
        eq(jobs.type, REGENERATE_JOB_TYPE),
        sql`${jobs.createdAt} > now() - interval '1 day'`,
      ),
    )
    .returning({ id: jobs.id });
  const rows = await db
    .update(generationRequests)
    .set({ createdAt: sql`${generationRequests.createdAt} - interval '1 day'` })
    .where(
      and(
        eq(generationRequests.ownerId, ownerId),
        sql`${generationRequests.createdAt} > now() - interval '1 day'`,
      ),
    )
    .returning({ id: generationRequests.id });
  return rows.length + regenerations.length;
}

const FILL_REQUEST_QUANTITY = 5;

// Rewinds, then inserts finished (cancelled, job-less) requests of five questions created now until
// `limit` questions are counted today. `limit` is the app's USER_DAILY_QUESTION_LIMIT (src/lib cannot
// import the feature).
export async function fillDailyUsage<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
  limit: number,
): Promise<void> {
  await rewindDailyUsage(db, ownerId);
  const count = Math.ceil(limit / FILL_REQUEST_QUANTITY);
  await db.insert(generationRequests).values(
    Array.from({ length: count }, () => ({
      ownerId,
      status: "cancelled",
      params: {
        grade: 8,
        topicTitle: "E2E daily budget",
        type: "multiple_choice",
        quantity: FILL_REQUEST_QUANTITY,
        difficulty: "sedang",
      },
    })),
  );
}

// The export job type (src/lib cannot import the feature's EXPORT_JOB_TYPE).
const RENDER_EXPORT_JOB_TYPE = "render_export";

// Service connection (RLS bypassed), explicit owner filter on every statement. Assessments go
// first: their sections, items, export rows and usage records cascade, and a template still used
// by an assessment cannot be deleted. Then the templates, then the export jobs (and with them the
// hourly export cap). Trashed rows go too. Stored files are the caller's (the route's) job.
export async function deleteAssessmentData<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
): Promise<AssessmentReset> {
  const removed = await db
    .delete(assessments)
    .where(eq(assessments.ownerId, ownerId))
    .returning({ id: assessments.id });
  // Export rows of an assessment cascade above; any left over (none expected) would block the jobs.
  await db.delete(exports).where(eq(exports.ownerId, ownerId));
  const templates = await db
    .delete(schoolTemplates)
    .where(eq(schoolTemplates.ownerId, ownerId))
    .returning({ id: schoolTemplates.id });
  const exportJobs = await db
    .delete(jobs)
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.type, RENDER_EXPORT_JOB_TYPE)))
    .returning({ id: jobs.id });
  return {
    assessments: removed.length,
    templates: templates.length,
    exportJobs: exportJobs.length,
  };
}

// Jobs of the given types (src/lib cannot import the features' job type names: the route passes
// them): the live ones are cancelled, so nothing runs against deleted rows, and the ones of the
// last day move back one day, out of today's caps (structure proposals, solves). Rows stay: an
// ai_calls row may point at them. Returns how many rows changed.
async function retireJobs<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
  types: readonly string[],
): Promise<number> {
  if (types.length === 0) return 0;
  const ofOwner = and(eq(jobs.ownerId, ownerId), inArray(jobs.type, [...types]));
  const cancelled = await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(and(ofOwner, inArray(jobs.status, ["queued", "deferred"])))
    .returning({ id: jobs.id });
  const rewound = await db
    .update(jobs)
    .set({ createdAt: sql`${jobs.createdAt} - interval '1 day'` })
    .where(and(ofOwner, sql`${jobs.createdAt} > now() - interval '1 day'`))
    .returning({ id: jobs.id });
  return new Set([...cancelled, ...rewound].map((row) => row.id)).size;
}

// Service connection (RLS bypassed), explicit owner filter on every statement. Like the trash
// purge (MAT-11), citations of banked questions lose their material link and excerpt first (a
// trigger clears the page and section links); the materials then cascade to their pages and
// sections; folders, upload reservations and the OCR day counts go; the material jobs are retired
// (`jobTypes`: ingestion, OCR, structure proposals). Stored files are the caller's (the route's).
export async function deleteMaterialData<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
  jobTypes: readonly string[],
): Promise<MaterialReset> {
  await db
    .update(questionSources)
    .set({ materialId: null, excerpt: null })
    .where(
      and(eq(questionSources.ownerId, ownerId), isNotNull(questionSources.materialId)),
    );
  const removed = await db
    .delete(materials)
    .where(eq(materials.ownerId, ownerId))
    .returning({ id: materials.id });
  const removedFolders = await db
    .delete(folders)
    .where(eq(folders.ownerId, ownerId))
    .returning({ id: folders.id });
  const uploads = await db
    .delete(materialUploads)
    .where(eq(materialUploads.ownerId, ownerId))
    .returning({ id: materialUploads.id });
  await db.delete(ocrUsage).where(eq(ocrUsage.ownerId, ownerId));
  return {
    materials: removed.length,
    folders: removedFolders.length,
    uploads: uploads.length,
    jobs: await retireJobs(db, ownerId, jobTypes),
  };
}

// Service connection (RLS bypassed), explicit owner filter. The sessions cascade to their
// solutions; the solver jobs (`jobTypes`) are retired, which gives back today's solves. Stored
// photos are the caller's (the route's).
export async function deleteSolverData<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: PgAsyncDatabase<TQueryResult, TRelations>,
  ownerId: string,
  jobTypes: readonly string[],
): Promise<SolverReset> {
  const removed = await db
    .delete(solverSessions)
    .where(eq(solverSessions.ownerId, ownerId))
    .returning({ id: solverSessions.id });
  return { sessions: removed.length, jobs: await retireJobs(db, ownerId, jobTypes) };
}
