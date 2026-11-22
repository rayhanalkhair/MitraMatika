// The approval gate (decision 6, VER-07). The status, approved_at and approved_snapshot_hash
// columns are client-writable under RLS (Ruling R7), so nothing here trusts them: approval
// recomputes the snapshot from the actual rows under the assessment row lock, and the export gate
// (`isApprovedAndValid`, Task 9) recomputes it again and compares it with the stored hash.
//
// Ruling R11: the per-item approval facts (the pin IS the question's approved version, in the bank,
// not trashed, no unresolved mismatch) are judged once, at approve time, under the lock. After
// approval the gate checks only the structure (the hash and that every pinned version still
// exists), so a later edit, regeneration or trash of a question never breaks an approved paper: it
// keeps its pinned versions. A rewritten pin changes the hash (stale, Ruling R12); reopening and
// approving again re-checks everything.
//
// The snapshot hash is sha-256 over the canonical JSON (keys sorted at every level) of what the
// documents print: the assessment's fields, the template id and its PRINTED fields (Ruling R26:
// school name, header lines in order, the logo's key and content hash, subject, student fields,
// default instructions, paper size and font; not its name, default flag or row version, so
// switching the default, renaming or restoring a template does not invalidate an approval), the
// scoring mode, the shuffle seed, and the sections in order with their items in numbered
// (shuffled) order, each with its pinned version id and its points (in hundredths, after the
// scoring mode is applied). Version 2 of the content (v: 2) replaced the template row version:
// every approval made before it went stale once, on the deploy (accepted before launch).
import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  questions,
  questionVersions,
  schoolTemplates,
  verificationRuns,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { fromDbStatus, isRegenerationMarker } from "@/features/generation";
import { isUuid, lockAssessment, touchAssessment, type AssessmentDb } from "./lock";
import { SCORING_MODES, scorePoints, toHundredths, type ScoringMode } from "./scoring";
import { numberedOrder } from "./shuffle";

export interface SnapshotItem {
  itemId: string;
  questionId: string;
  /** The pinned question version. */
  versionId: string;
  /** The teacher's own points as stored (manual and normalised modes use them). */
  storedPoints: number;
  /** The question is approved and in the bank. */
  questionApproved: boolean;
  /** The pinned version is the question's approved version (not an older or unreviewed one). */
  pinnedIsApproved: boolean;
  /** The question is in the trash. */
  trashed: boolean;
  /** The pinned version's latest verification is `ketidaksesuaian`. */
  mismatch: boolean;
  /** The teacher approved the question with a note for exactly this version (VER-07 override). */
  overridden: boolean;
}

/**
 * What the documents print of the template (Ruling R26), as stored. The JSON columns stay as
 * stored, so any change to them (also an order change) changes the hash.
 */
export interface TemplatePrint {
  schoolName: string;
  headerLines: unknown;
  /** The stored logo: its object key and the sha-256 of its bytes (null: uploaded before R26). */
  logo: { key: string; sha256: string | null } | null;
  subject: string;
  studentFields: unknown;
  defaultInstructionsMd: string | null;
  paperSize: string;
  font: string;
}

export interface ApprovalSnapshot {
  assessmentId: string;
  title: string;
  kind: string;
  grade: number;
  examDate: string | null;
  durationMinutes: number | null;
  instructionsMd: string | null;
  scoringMode: ScoringMode;
  shuffleSeed: number | null;
  template: { id: string; trashed: boolean; printed: TemplatePrint } | null;
  /** Sections in outline order, their items in outline order (not shuffled). */
  sections: {
    id: string;
    title: string;
    instructionsMd: string | null;
    items: SnapshotItem[];
  }[];
}

/** An item named by its number in the editor's outline (1-based across sections). */
export interface ItemNumber {
  itemId: string;
  number: number;
}

export type ApprovalProblem =
  | { code: "empty" }
  | { code: "trashed"; template: true }
  | ({ code: "trashed" | "notApproved" | "mismatch" } & ItemNumber)
  | { code: "badTotal"; mode: ScoringMode; total: number; unscored: ItemNumber[] };

const outlineItems = (snapshot: ApprovalSnapshot) =>
  snapshot.sections.flatMap((section) => section.items);

/**
 * Every reason the assessment cannot be approved, in a stable order: the template, then item by
 * item (trashed, not approved, unresolved mismatch), then the scoring. Item numbers are the
 * editor's outline numbers (what the teacher sees next to each question).
 */
export function checkApproval(
  snapshot: ApprovalSnapshot,
): Result<void, ApprovalProblem[]> {
  const items = outlineItems(snapshot);
  if (items.length === 0) return err([{ code: "empty" }]);
  const problems: ApprovalProblem[] = [];
  if (snapshot.template?.trashed) problems.push({ code: "trashed", template: true });
  items.forEach((item, index) => {
    const at = { itemId: item.itemId, number: index + 1 };
    if (item.trashed) problems.push({ code: "trashed", ...at });
    if (!item.questionApproved || !item.pinnedIsApproved) {
      problems.push({ code: "notApproved", ...at });
    }
    if (item.mismatch && !item.overridden) problems.push({ code: "mismatch", ...at });
  });

  const mode = snapshot.scoringMode;
  const stored = items.map((item) => item.storedPoints);
  const points = scorePoints(mode, stored);
  const total = (points ?? []).reduce((sum, value) => sum + toHundredths(value), 0);
  // Equal mode hands out the points itself; the teacher's own points must all be positive.
  const unscored =
    mode === "equal"
      ? []
      : items
          .map((item, index) => ({ itemId: item.itemId, number: index + 1 }))
          .filter((_, index) => toHundredths(stored[index]) <= 0);
  const totalOk = mode === "manual" ? total > 0 : total === 10000;
  if (!totalOk || unscored.length > 0) {
    problems.push({ code: "badTotal", mode, total: total / 100, unscored });
  }
  return problems.length === 0 ? ok() : err(problems);
}

/** The points each item carries, by item id, after the scoring mode (null: not computable). */
export function snapshotPoints(snapshot: ApprovalSnapshot): Map<string, number> | null {
  const items = outlineItems(snapshot);
  const points = scorePoints(
    snapshot.scoringMode,
    items.map((item) => item.storedPoints),
  );
  if (!points) return null;
  return new Map(items.map((item, index) => [item.itemId, points[index]]));
}

/** The order and numbers the documents print (shuffle.ts). */
export const snapshotOrder = (snapshot: ApprovalSnapshot) =>
  numberedOrder(
    snapshot.sections.map((section) => ({
      id: section.id,
      itemIds: section.items.map((item) => item.itemId),
    })),
    snapshot.shuffleSeed,
  );

/** JSON with the keys of every object sorted, so equal values always give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha-256 (hex) of the canonical JSON of what the documents print (see the top of this file).
 * Task 9 recomputes it from a fresh snapshot and compares it with the stored hash.
 */
export function computeSnapshotHash(snapshot: ApprovalSnapshot): string {
  const points = snapshotPoints(snapshot);
  const byId = new Map(outlineItems(snapshot).map((item) => [item.itemId, item]));
  const sections = new Map(snapshot.sections.map((section) => [section.id, section]));
  const content = {
    v: 2,
    assessment: {
      id: snapshot.assessmentId,
      title: snapshot.title,
      kind: snapshot.kind,
      grade: snapshot.grade,
      examDate: snapshot.examDate,
      durationMinutes: snapshot.durationMinutes,
      instructionsMd: snapshot.instructionsMd,
    },
    scoringMode: snapshot.scoringMode,
    shuffleSeed: snapshot.shuffleSeed,
    template: snapshot.template
      ? { id: snapshot.template.id, printed: snapshot.template.printed }
      : null,
    sections: snapshotOrder(snapshot).map((numbered) => {
      const section = sections.get(numbered.sectionId);
      return {
        id: numbered.sectionId,
        title: section?.title ?? "",
        instructionsMd: section?.instructionsMd ?? null,
        items: numbered.items.map(({ itemId, number }) => {
          const item = byId.get(itemId);
          return {
            number,
            itemId,
            questionId: item?.questionId ?? "",
            versionId: item?.versionId ?? "",
            // Not computable (normalised with no points): the stored points stand in.
            points: toHundredths(points?.get(itemId) ?? item?.storedPoints ?? 0),
          };
        }),
      };
    }),
  };
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

interface Loaded {
  snapshot: ApprovalSnapshot;
  status: "draft" | "approved";
  approvedAt: Date | null;
  storedHash: string | null;
  /** Every item row resolved to its pinned version (none lost to a missing version). */
  pinsComplete: boolean;
}

const overrideVersion = (override: unknown): string | null => {
  if (typeof override !== "object" || override === null) return null;
  const { note, versionId } = override as { note?: unknown; versionId?: unknown };
  return typeof note === "string" && note.trim() !== "" && typeof versionId === "string"
    ? versionId
    : null;
};

/**
 * The snapshot of the owner's visible assessment, read from the actual rows (the caller holds the
 * row lock when it approves). Null for unknown, foreign, trashed and malformed ids.
 */
export async function loadSnapshot(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<Loaded | null> {
  const { ownerId, assessmentId } = input;
  if (!isUuid(assessmentId)) return null;
  const row = (
    await db
      .select()
      .from(assessments)
      .where(
        and(
          eq(assessments.id, assessmentId),
          eq(assessments.ownerId, ownerId),
          isNull(assessments.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (!row) return null;

  const template = row.templateId
    ? ((
        await db
          .select({
            id: schoolTemplates.id,
            deletedAt: schoolTemplates.deletedAt,
            schoolName: schoolTemplates.schoolName,
            headerLines: schoolTemplates.headerLines,
            logoKey: schoolTemplates.logoKey,
            logoSha256: schoolTemplates.logoSha256,
            subject: schoolTemplates.subject,
            studentFields: schoolTemplates.studentFields,
            defaultInstructionsMd: schoolTemplates.defaultInstructionsMd,
            paperSize: schoolTemplates.paperSize,
            font: schoolTemplates.font,
          })
          .from(schoolTemplates)
          .where(
            and(
              eq(schoolTemplates.id, row.templateId),
              eq(schoolTemplates.ownerId, ownerId),
            ),
          )
          .limit(1)
      ).at(0) ?? null)
    : null;

  const sectionRows = await db
    .select()
    .from(assessmentSections)
    .where(
      and(
        eq(assessmentSections.assessmentId, assessmentId),
        eq(assessmentSections.ownerId, ownerId),
      ),
    )
    .orderBy(asc(assessmentSections.sortOrder), asc(assessmentSections.id));

  // Items counted without the joins: one whose pinned version is gone would drop out below.
  const itemTotal =
    (
      await db
        .select({ n: count() })
        .from(assessmentItems)
        .where(
          and(
            eq(assessmentItems.assessmentId, assessmentId),
            eq(assessmentItems.ownerId, ownerId),
          ),
        )
    ).at(0)?.n ?? 0;

  const itemRows = await db
    .select({
      itemId: assessmentItems.id,
      sectionId: assessmentItems.sectionId,
      questionId: assessmentItems.questionId,
      versionId: assessmentItems.questionVersionId,
      points: assessmentItems.points,
      versionStatus: questionVersions.verificationStatus,
      status: questions.status,
      bankedAt: questions.bankedAt,
      deletedAt: questions.deletedAt,
      approvalOverride: questions.approvalOverride,
      approvedVersionId: questions.approvedVersionId,
    })
    .from(assessmentItems)
    .innerJoin(
      questionVersions,
      and(
        eq(questionVersions.id, assessmentItems.questionVersionId),
        eq(questionVersions.ownerId, assessmentItems.ownerId),
      ),
    )
    .innerJoin(
      questions,
      and(
        eq(questions.id, assessmentItems.questionId),
        eq(questions.ownerId, assessmentItems.ownerId),
      ),
    )
    .where(
      and(
        eq(assessmentItems.assessmentId, assessmentId),
        eq(assessmentItems.ownerId, ownerId),
      ),
    )
    .orderBy(asc(assessmentItems.sortOrder), asc(assessmentItems.id));

  // The effective verification status of each pinned version: its latest real run (regeneration
  // markers are history, not runs), else the status the version was saved with.
  const latest = new Map<string, string>();
  const versionIds = [...new Set(itemRows.map((item) => item.versionId))];
  if (versionIds.length > 0) {
    const runs = await db
      .select({
        versionId: verificationRuns.questionVersionId,
        status: verificationRuns.status,
        crossCheck: verificationRuns.crossCheck,
      })
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.ownerId, ownerId),
          inArray(verificationRuns.questionVersionId, versionIds),
        ),
      )
      .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
    for (const run of runs) {
      if (!isRegenerationMarker(run.crossCheck)) latest.set(run.versionId, run.status);
    }
  }

  const toItem = (item: (typeof itemRows)[number]): SnapshotItem => ({
    itemId: item.itemId,
    questionId: item.questionId,
    versionId: item.versionId,
    storedPoints: Number(item.points),
    questionApproved: item.status === "approved" && item.bankedAt !== null,
    pinnedIsApproved: item.approvedVersionId === item.versionId,
    trashed: item.deletedAt !== null,
    mismatch:
      fromDbStatus(latest.get(item.versionId) ?? item.versionStatus) ===
      "ketidaksesuaian",
    overridden: overrideVersion(item.approvalOverride) === item.versionId,
  });

  const mode = SCORING_MODES.find((value) => value === row.scoringMode) ?? "equal";
  return {
    snapshot: {
      assessmentId: row.id,
      title: row.title,
      kind: row.kind,
      grade: row.grade,
      examDate: row.examDate,
      durationMinutes: row.durationMinutes,
      instructionsMd: row.instructionsMd,
      scoringMode: mode,
      shuffleSeed: row.shuffleSeed,
      template: template
        ? {
            id: template.id,
            trashed: template.deletedAt !== null,
            printed: {
              schoolName: template.schoolName,
              headerLines: template.headerLines,
              logo:
                template.logoKey === null
                  ? null
                  : { key: template.logoKey, sha256: template.logoSha256 },
              subject: template.subject,
              studentFields: template.studentFields,
              defaultInstructionsMd: template.defaultInstructionsMd,
              paperSize: template.paperSize,
              font: template.font,
            },
          }
        : null,
      sections: sectionRows.map((section) => ({
        id: section.id,
        title: section.title,
        instructionsMd: section.instructionsMd,
        items: itemRows.filter((item) => item.sectionId === section.id).map(toItem),
      })),
    },
    status: row.status === "approved" ? "approved" : "draft",
    approvedAt: row.approvedAt,
    storedHash: row.approvedSnapshotHash,
    pinsComplete: itemTotal === itemRows.length,
  };
}

/**
 * Whether the export gate refuses an approved snapshot: the stored hash is not the current one, a
 * pinned version is gone, or the template is in the trash (it prints the letterhead; restoring it
 * makes the approval valid again, since nothing printed changed).
 */
function gateRefuses(loaded: Loaded, hash: string): boolean {
  return (
    !loaded.pinsComplete ||
    loaded.storedHash !== hash ||
    loaded.snapshot.template?.trashed === true
  );
}

export interface ApprovalState {
  /** What would block an approval now (empty: ready). */
  problems: ApprovalProblem[];
  /** The hash of the current snapshot: the page posts it back so approval names what was seen. */
  hash: string;
  /** The status column says approved (it may be forged or stale: see `stale`). */
  approved: boolean;
  approvedAt: string | null;
  /**
   * Approved, but the export gate refuses it: the stored hash is not the hash of the current
   * structure (a printed template change, a rewritten pin), a pinned version is gone, or the
   * template is in the trash (`problems` then names it).
   */
  stale: boolean;
}

/** What the approval panel shows. Null for unknown, foreign, trashed and malformed ids. */
export async function getApprovalState(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<ApprovalState | null> {
  const loaded = await loadSnapshot(db, input);
  if (!loaded) return null;
  const checked = checkApproval(loaded.snapshot);
  const hash = computeSnapshotHash(loaded.snapshot);
  const approved = loaded.status === "approved";
  return {
    problems: checked.ok ? [] : checked.error,
    hash,
    approved,
    approvedAt: loaded.approvedAt?.toISOString() ?? null,
    stale: approved && gateRefuses(loaded, hash),
  };
}

export type ApproveFailure =
  | "notFound"
  | "approved"
  | "conflict"
  | { code: "notReady"; problems: ApprovalProblem[] };

/**
 * Approves the assessment: locks the row, recomputes the snapshot from the actual rows, refuses
 * with every problem (`notReady`), refuses when the page saw a different snapshot (`conflict`,
 * when `expectedHash` is given), then stores approved_at, the snapshot hash and the status.
 */
export async function approve(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string; expectedHash?: string; now?: Date },
): Promise<Result<{ hash: string }, ApproveFailure>> {
  const { ownerId, assessmentId } = input;
  const locked = await lockAssessment(tx, { ownerId, assessmentId });
  if (!locked.ok) return locked;
  const loaded = await loadSnapshot(tx, { ownerId, assessmentId });
  if (!loaded) return err("notFound");
  const checked = checkApproval(loaded.snapshot);
  if (!checked.ok) return err({ code: "notReady", problems: checked.error });
  const hash = computeSnapshotHash(loaded.snapshot);
  if (input.expectedHash !== undefined && input.expectedHash !== hash)
    return err("conflict");
  await tx
    .update(assessments)
    .set({
      status: "approved",
      approvedAt: input.now ?? new Date(),
      approvedSnapshotHash: hash,
    })
    .where(and(eq(assessments.id, assessmentId), eq(assessments.ownerId, ownerId)));
  await touchAssessment(tx, { ownerId, assessmentId });
  return ok({ hash });
}

/** Clears the approval, its time and hash, and the status. A draft is left as it is. */
export async function reopen(
  tx: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<Result<{ reopened: boolean }, "notFound">> {
  const locked = await lockAssessment(tx, input, { allowApproved: true });
  if (!locked.ok) return err("notFound");
  if (!locked.data.approved) return ok({ reopened: false });
  await tx
    .update(assessments)
    .set({ status: "draft", approvedAt: null, approvedSnapshotHash: null })
    .where(
      and(eq(assessments.id, input.assessmentId), eq(assessments.ownerId, input.ownerId)),
    );
  await touchAssessment(tx, input);
  return ok({ reopened: true });
}

export type GateFailure = "notFound" | "notApproved" | "stale";

/**
 * The export gate (Task 9). The status says approved (with its time), every pinned version still
 * exists, the template is not in the trash, and the stored hash equals the hash recomputed from
 * the actual rows. It does NOT judge the
 * questions again (Ruling R11): approval captured those facts under the lock, and the paper keeps
 * its pinned versions whatever happens to the questions afterwards. Task 9 renders from the
 * returned snapshot, in the same transaction.
 */
export async function verifyApproval(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<Result<{ snapshot: ApprovalSnapshot; hash: string }, GateFailure>> {
  const loaded = await loadSnapshot(db, input);
  if (!loaded) return err("notFound");
  if (loaded.status !== "approved" || loaded.approvedAt === null) {
    return err("notApproved");
  }
  const hash = computeSnapshotHash(loaded.snapshot);
  if (gateRefuses(loaded, hash)) return err("stale");
  return ok({ snapshot: loaded.snapshot, hash });
}

/** True only when `verifyApproval` passes: never the status column alone. */
export async function isApprovedAndValid(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<boolean> {
  return (await verifyApproval(db, input)).ok;
}
