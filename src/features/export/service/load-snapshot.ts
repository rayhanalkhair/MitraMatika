// Reads the content of the pinned versions for the document model. The structure, order, seed and
// scoring come from the approval snapshot (Task 5), so the documents and the approval hash read
// the same rows. The caller applies runAsUser (Ruling R1); every statement also names the owner.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import {
  loadSnapshot,
  type ApprovalSnapshot,
  type AssessmentDb,
} from "@/features/assessments";
import { questionVersions } from "@/lib/db/schema";
import type { ExportSnapshot, ExportVersion } from "./document-model";

const label = z.enum(["A", "B", "C", "D"]);
const contentSchema = z.object({
  options: z.array(z.object({ label, text_md: z.string() })).catch([]),
  answer: z.object({ correctLabel: label }).nullable().catch(null),
  steps: z.array(z.string()).catch([]),
});

/**
 * The owner's assessment with the content of every pinned version, draft or approved. `notFound`
 * for an unknown, foreign, trashed or malformed id; `missingVersion` when a pinned version cannot
 * be read (nothing is printed from a partial paper).
 */
export async function loadExportSnapshot(
  db: AssessmentDb,
  input: { ownerId: string; assessmentId: string },
): Promise<Result<ExportSnapshot, "notFound" | "missingVersion">> {
  const loaded = await loadSnapshot(db, input);
  if (!loaded) return err("notFound");
  if (!loaded.pinsComplete) return err("missingVersion");
  return loadVersions(db, { ownerId: input.ownerId, snapshot: loaded.snapshot });
}

/**
 * The content of every version the snapshot pins (the export job passes the snapshot the approval
 * gate returned, in the same transaction). `missingVersion` when one cannot be read.
 */
export async function loadVersions(
  db: AssessmentDb,
  input: { ownerId: string; snapshot: ApprovalSnapshot },
): Promise<Result<ExportSnapshot, "missingVersion">> {
  const { snapshot } = input;
  const versionIds = [
    ...new Set(
      snapshot.sections.flatMap((section) => section.items.map((item) => item.versionId)),
    ),
  ];
  const rows =
    versionIds.length === 0
      ? []
      : await db
          .select({
            id: questionVersions.id,
            stemMd: questionVersions.stemMd,
            options: questionVersions.options,
            answer: questionVersions.answer,
            steps: questionVersions.steps,
            explanationMd: questionVersions.explanationMd,
          })
          .from(questionVersions)
          .where(
            and(
              eq(questionVersions.ownerId, input.ownerId),
              inArray(questionVersions.id, versionIds),
            ),
          );
  const versions = new Map<string, ExportVersion>();
  for (const row of rows) {
    const parsed = contentSchema.parse({
      options: row.options,
      answer: row.answer,
      steps: row.steps,
    });
    versions.set(row.id, {
      stemMd: row.stemMd,
      options: parsed.options.map((option) => ({
        label: option.label,
        textMd: option.text_md,
      })),
      correctLabel: parsed.answer?.correctLabel ?? null,
      steps: parsed.steps,
      explanationMd: row.explanationMd,
    });
  }
  if (versions.size !== versionIds.length) return err("missingVersion");
  return ok({ ...snapshot, versions });
}
