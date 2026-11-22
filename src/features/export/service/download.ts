// GET /api/exports/[id]: one stored export file for its owner. The session decides the owner; the
// row is read on the service connection with an explicit owner filter, so another teacher's file,
// an unknown id and a malformed one all look the same (404). An expired file is 410 (also before
// the purge has removed it). A file of another approval than the current one (Ruling R27: the
// assessment was reopened, or reopened, changed and approved again, or its approval no longer
// passes the gate) is 410 "superseded": it does not match what is approved now. Otherwise a 302 to a signed URL valid for 300 s, which downloads as
// an attachment named after the assessment title. Nothing is cached.
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { authorizeAction } from "@/features/auth";
import { verifyApproval, type AssessmentDb } from "@/features/assessments";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { assessments, exports } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { downloadName, isOwnExportKey, type ExportFile } from "./file-names";

export const DOWNLOAD_URL_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

export interface DownloadDeps {
  authorize: typeof authorizeAction;
  db: AssessmentDb;
  store: () => ObjectStore;
  now?: () => Date;
}

const status = (code: number, error: string) =>
  Response.json({ error }, { status: code, headers: NO_STORE });

export async function handleExportDownload(
  id: string,
  deps: DownloadDeps,
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) return status(401, authorization.error);
  if (!UUID.test(id)) return status(404, "notFound");
  const ownerId = authorization.data.userId;

  try {
    const row = (
      await deps.db
        .select({
          document: exports.document,
          format: exports.format,
          objectKey: exports.objectKey,
          expiresAt: exports.expiresAt,
          snapshotHash: exports.snapshotHash,
          assessmentId: exports.assessmentId,
          title: assessments.title,
        })
        .from(exports)
        .innerJoin(
          assessments,
          and(
            eq(assessments.id, exports.assessmentId),
            eq(assessments.ownerId, exports.ownerId),
          ),
        )
        .where(
          and(
            eq(exports.id, id),
            eq(exports.ownerId, ownerId),
            isNull(assessments.deletedAt),
          ),
        )
        .limit(1)
    ).at(0);
    if (!row) return status(404, "notFound");
    const now = deps.now?.() ?? new Date();
    if (row.expiresAt.getTime() <= now.getTime()) return status(410, "expired");
    // The same gate as the export itself: the hash is recomputed from the rows (R7/R11).
    const gate = await verifyApproval(deps.db, {
      ownerId,
      assessmentId: row.assessmentId,
    });
    if (!gate.ok || gate.data.hash !== row.snapshotHash) {
      return status(410, "superseded");
    }
    // The job writes the key; it must still sit under this owner's export prefix.
    if (!isOwnExportKey(ownerId, row.objectKey)) {
      logger.warn(
        { module: "export", exportId: id },
        "export: key outside the owner prefix",
      );
      return status(404, "notFound");
    }
    const url = await deps.store().signedGetUrl(row.objectKey, DOWNLOAD_URL_SECONDS, {
      downloadName: downloadName(row.title, {
        document: row.document,
        format: row.format,
      } as ExportFile),
    });
    return new Response(null, {
      status: 302,
      headers: { Location: url, ...NO_STORE, "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    logger.error(
      { module: "export", err: safeErrorSummary(error) },
      "export: could not prepare a download",
    );
    return status(500, "unavailable");
  }
}
