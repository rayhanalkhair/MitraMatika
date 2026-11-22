import "server-only";
// GET /api/materials/[id]/file: the stored file of one of the signed-in teacher's live materials,
// for the page viewer (decision 7: an image is shown as it is; a PDF page is rendered in the
// browser with pdfjs-dist). The session decides the owner and the row is read on the service
// connection with an explicit owner filter, so another teacher's material, a trashed one and an
// unknown or malformed id all answer 404. With R2 the answer is a 302 to a signed URL valid for
// 300 s (a file of up to 25 MB never passes through the function); with the in-memory store of
// development and e2e (Ruling R2, whose signed URLs are placeholders) the bytes are sent inline.
// Nothing is cached, and the file can never run as a page of this origin.
import { and, eq, isNull } from "drizzle-orm";
import type { ActionAuthorization } from "@/features/auth";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { materials } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { isOwnMaterialKey, type MaterialDb } from "./upload";

export const FILE_URL_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

export interface MaterialFileDeps {
  authorize: () => Promise<ActionAuthorization>;
  db: MaterialDb;
  store: () => ObjectStore;
  /** True when files live in the in-memory store (development, e2e): answer with the bytes. */
  inline: () => boolean;
}

const status = (code: number) => new Response(null, { status: code, headers: NO_STORE });

export async function handleMaterialFileRequest(
  id: string,
  deps: MaterialFileDeps,
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) return status(401);
  if (!UUID.test(id)) return status(404);
  const ownerId = authorization.data.userId;
  try {
    const row = (
      await deps.db
        .select({ objectKey: materials.objectKey, mime: materials.mime })
        .from(materials)
        .where(
          and(
            eq(materials.id, id.toLowerCase()),
            eq(materials.ownerId, ownerId),
            isNull(materials.deletedAt),
          ),
        )
        .limit(1)
    ).at(0);
    if (!row || !isOwnMaterialKey(ownerId, row.objectKey)) return status(404);
    const store = deps.store();
    if (deps.inline()) {
      const bytes = await store.get(row.objectKey);
      if (!bytes) return status(404);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": row.mime,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'inline; filename="material"',
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    const url = await store.signedGetUrl(row.objectKey, FILE_URL_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { Location: url, ...NO_STORE, "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    logger.error(
      { module: "materials", err: safeErrorSummary(error) },
      "materials: could not serve a material file",
    );
    return status(500);
  }
}
