import "server-only";
// OCR on demand (decision 5): the queue. The teacher picks pages whose ocr_status is `available` or
// `failed` (or `queued` with no live job left: see pageIsBusy) of one of their live, read PDF or
// image materials. queueOcr reserves the pages in the daily cap (ocr-quota.ts), marks them
// `queued` and queues one `ocr_pages` job (ocr-job.ts). A PDF page has no picture on the server
// (Ruling R3): before queueing, the browser renders each selected page with pdfjs-dist and PUTs
// the PNG to a staging key `uploads/<ownerId>/<materialId>/pages/<n>.png` signed by
// prepareOcrUploads. An image material uses its stored file, unless it is larger than the vision
// model takes: then the browser sends a smaller PNG of it as page 1 the same way.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { jobs, materialPages, materials } from "@/lib/db/schema";
import { createJobQueue } from "@/lib/jobs/queue";
import { err, ok, type Result } from "@/lib/result";
import { pngSize } from "@/lib/images/dimensions";
import { assertAppStorageRoom } from "@/lib/storage/app-total";
import { assertSafeKey, type ObjectStore } from "@/lib/storage/types";
import {
  MAX_PAGE_IMAGE_BYTES,
  MAX_PAGE_IMAGE_SIDE,
  MAX_PAGES_PER_REQUEST,
  OCR_PAGES_JOB,
  PAGE_UPLOAD_URL_SECONDS,
  type PageUploadError,
  type QueueOcrError,
} from "../schema/ocr";
import { lockOcrOwner, reserveOcrPages } from "./ocr-quota";
import { inkShare, isBlankShare } from "../schema/page-ink";
import { pngRgba } from "./png-pixels";
import type { MaterialDb } from "./upload";

export { USER_DAILY_OCR_PAGES } from "../schema/ocr";

const MAX_ATTEMPTS = 3;
const ACTIVE = ["queued", "running", "deferred"];
const ELIGIBLE = ["available", "failed"];
export const OCR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = OCR_UUID;
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// ---------------------------------------------------------------------------------------------
// Keys and the page image

function pageKey(
  root: "uploads" | "materials",
  owner: string,
  material: string,
  n: number,
) {
  if (!UUID.test(owner) || !UUID.test(material) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error("ocr: page keys need lower-case uuids and a page number");
  }
  const key = `${root}/${owner}/${material}/pages/${String(n)}.png`;
  assertSafeKey(key);
  return key;
}

/** Where the browser PUTs a rendered page (staging; the only page key ever signed). */
export const pageStagingKey = (ownerId: string, materialId: string, pageNo: number) =>
  pageKey("uploads", ownerId, materialId, pageNo);
/** A checked page image, written by the job only (under the material's own prefix). */
export const pageImageKey = (ownerId: string, materialId: string, pageNo: number) =>
  pageKey("materials", ownerId, materialId, pageNo);

export const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/**
 * Whether bytes are a page image the job may send: a PNG (by its signature, not a name) of at
 * most MAX_PAGE_IMAGE_BYTES whose header declares 1..MAX_PAGE_IMAGE_SIDE pixels a side, whose
 * pixels decode, and which is not blank (a scan pdf.js could not draw renders white).
 */
export function checkPageImage(
  bytes: Uint8Array,
): Result<void, "image_invalid" | "image_too_large" | "image_blank"> {
  if (bytes.length > MAX_PAGE_IMAGE_BYTES) return err("image_too_large");
  if (!startsWith(bytes, PNG_SIGNATURE)) return err("image_invalid");
  const size = pngSize(bytes);
  if (!size) return err("image_invalid");
  const sides = [size.width, size.height];
  if (sides.some((side) => side < 1)) return err("image_invalid");
  if (sides.some((side) => side > MAX_PAGE_IMAGE_SIDE)) return err("image_too_large");
  const pixels = pngRgba(bytes);
  if (!pixels) return err("image_invalid");
  if (isBlankShare(inkShare(pixels.rgba))) return err("image_blank");
  return ok();
}

/** A PDF page, and an image too large to send as it is, need a picture from the browser. */
export function needsPageUpload(material: { kind: string; sizeBytes: number }): boolean {
  return (
    material.kind === "pdf" ||
    (material.kind === "image" && material.sizeBytes > MAX_PAGE_IMAGE_BYTES)
  );
}

// ---------------------------------------------------------------------------------------------
// Queue and uploads

export const liveMaterial = (ownerId: string, materialId: string) =>
  and(
    eq(materials.id, materialId),
    eq(materials.ownerId, ownerId),
    isNull(materials.deletedAt),
  );

/**
 * The one rule for "busy": a live `ocr_pages` job (queued, running or deferred) of the page's
 * owner and material lists the page. Correlated with the material_pages row of the outer
 * statement (names written out in full, so they never bind to the jobs table).
 */
export const liveJobListsPage = sql`exists (select 1 from ${jobs}
    where ${jobs.ownerId} = "material_pages"."owner_id"
      and ${jobs.type} = ${OCR_PAGES_JOB}
      and ${inArray(jobs.status, ACTIVE)}
      and ${jobs.payload}->>'materialId' = "material_pages"."material_id"::text
      and ${jobs.payload}->'pageNos' @> to_jsonb("material_pages"."page_no"))`;

/**
 * A page is waiting for OCR only while a live job lists it; one left `queued` by a job that ended
 * without finishing it is `failed` for the teacher (offered again, editable).
 */
export const shownOcrStatus = sql<string>`case
    when ${materialPages.ocrStatus} = 'queued' and not ${liveJobListsPage} then 'failed'
    else ${materialPages.ocrStatus} end`;

/** The requested pages that may be sent to OCR now (sorted, no duplicates). */
async function eligiblePages(
  db: MaterialDb,
  input: { ownerId: string; materialId: string; pageNos: number[] },
): Promise<number[]> {
  const rows = await db
    .select({ pageNo: materialPages.pageNo, status: materialPages.ocrStatus })
    .from(materialPages)
    .where(
      and(
        eq(materialPages.materialId, input.materialId),
        eq(materialPages.ownerId, input.ownerId),
        inArray(materialPages.pageNo, input.pageNos),
        sql`(${inArray(materialPages.ocrStatus, ELIGIBLE)} or (${eq(
          materialPages.ocrStatus,
          "queued",
        )} and not ${liveJobListsPage}))`,
      ),
    )
    .orderBy(asc(materialPages.pageNo));
  return rows.map((row) => row.pageNo);
}

const dedupe = (pageNos: readonly number[]) =>
  [...new Set(pageNos)]
    .filter((n) => Number.isSafeInteger(n) && n >= 1)
    .sort((a, b) => a - b);

/**
 * Sends pages of one of the owner's live materials to OCR. Every page must be one of its pages
 * whose OCR is `available` or `failed` (else `pages`, nothing changes); the pages must fit in what
 * is left of today's cap (else `limit`, nothing counted). Call inside a transaction: the owner's
 * lock makes the count and the increment atomic, and the material's row lock keeps the trash out.
 * Returns the job and the pages left today.
 */
export async function queueOcr(
  tx: MaterialDb,
  input: { ownerId: string; materialId: string; pageNos: number[]; now: Date },
): Promise<Result<{ jobId: string; left: number; pageNos: number[] }, QueueOcrError>> {
  const { ownerId, materialId, now } = input;
  const pageNos = dedupe(input.pageNos);
  if (!UUID.test(materialId)) return err("notFound");
  if (pageNos.length === 0 || pageNos.length > MAX_PAGES_PER_REQUEST) return err("pages");
  await lockOcrOwner(tx, ownerId);
  const material = (
    await tx
      .select({ kind: materials.kind, status: materials.status })
      .from(materials)
      .where(liveMaterial(ownerId, materialId))
      .for("share")
  ).at(0);
  if (!material) return err("notFound");
  if (material.kind === "docx") return err("pages");
  if (material.status !== "ready" && material.status !== "needs_review")
    return err("pages");
  const eligible = await eligiblePages(tx, { ownerId, materialId, pageNos });
  if (eligible.length !== pageNos.length) return err("pages");
  const reserved = await reserveOcrPages(tx, { ownerId, pages: pageNos.length, now });
  if (!reserved.ok) return reserved;
  await tx
    .update(materialPages)
    .set({ ocrStatus: "queued", updatedAt: now })
    .where(
      and(
        eq(materialPages.materialId, materialId),
        eq(materialPages.ownerId, ownerId),
        inArray(materialPages.pageNo, pageNos),
      ),
    );
  const job = await createJobQueue(tx, () => now).enqueue({
    ownerId,
    type: OCR_PAGES_JOB,
    createdAt: now,
    payload: { materialId, pageNos, day: reserved.data.day },
    runAfter: now,
    maxAttempts: MAX_ATTEMPTS,
  });
  return ok({ jobId: job.id, left: reserved.data.left, pageNos });
}

/**
 * Signs one PUT per page image the browser rendered (exactly `size` bytes of image/png, valid for
 * PAGE_UPLOAD_URL_SECONDS) to the page's staging key. Only pages queueOcr would accept, of a live
 * material that needs pictures from the browser, and no more pages than are left today: an upload
 * that can never be used is never signed. Nothing is counted here.
 */
export async function prepareOcrUploads(
  db: MaterialDb,
  store: ObjectStore,
  input: {
    ownerId: string;
    materialId: string;
    pages: { pageNo: number; size: number }[];
    left: number;
  },
): Promise<Result<{ uploads: { pageNo: number; url: string }[] }, PageUploadError>> {
  const { ownerId, materialId } = input;
  if (!UUID.test(materialId)) return err("notFound");
  const pageNos = dedupe(input.pages.map((page) => page.pageNo));
  if (pageNos.length !== input.pages.length || pageNos.length > MAX_PAGES_PER_REQUEST) {
    return err("pages");
  }
  if (
    input.pages.some(
      (page) =>
        !Number.isSafeInteger(page.size) ||
        page.size < 1 ||
        page.size > MAX_PAGE_IMAGE_BYTES,
    )
  ) {
    return err("pages");
  }
  const material = (
    await db
      .select({
        kind: materials.kind,
        sizeBytes: materials.sizeBytes,
        status: materials.status,
      })
      .from(materials)
      .where(liveMaterial(ownerId, materialId))
  ).at(0);
  if (!material) return err("notFound");
  if (!needsPageUpload(material)) return err("pages");
  if (material.status !== "ready" && material.status !== "needs_review")
    return err("pages");
  const eligible = await eligiblePages(db, { ownerId, materialId, pageNos });
  if (eligible.length !== pageNos.length) return err("pages");
  if (pageNos.length > input.left) return err("limit");
  // The app-wide cap (ADR-0022), without the lock: the staged images are not counted until the
  // job keeps them (which checks again), so this only tells the teacher early and signs nothing.
  const room = await assertAppStorageRoom(
    db,
    input.pages.reduce((sum, page) => sum + page.size, 0),
    "ocr",
  );
  if (!room.ok) return err("appFull");
  const uploads = await Promise.all(
    input.pages.map(async (page) => ({
      pageNo: page.pageNo,
      url: await store.signedPutUrl(
        pageStagingKey(ownerId, materialId, page.pageNo),
        "image/png",
        page.size,
        PAGE_UPLOAD_URL_SECONDS,
      ),
    })),
  );
  return ok({ uploads: uploads.sort((a, b) => a.pageNo - b.pageNo) });
}
