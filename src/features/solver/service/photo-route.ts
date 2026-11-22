import "server-only";
// GET /api/solve/[id]/photo: the photo of one of the signed-in teacher's live sessions, shown
// beside its reading for the confirmation (SOL-02). The session decides the owner; the row is read
// on the service connection with an explicit owner filter and the key must be that session's own
// final photo key, so another teacher's session, a trashed one, a photo already deleted (7 days)
// and an unknown or malformed id all answer 404. With R2 the answer is a 302 to a signed URL valid
// for 300 s; with the in-memory store of development and e2e the bytes are sent inline. Nothing is
// cached, and the image can never run as a page of this origin.
import { and, eq, isNull } from "drizzle-orm";
import type { ActionAuthorization } from "@/features/auth";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { solverSessions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { mimeOfExt, parseSessionKey } from "./keys";
import type { SolverDb } from "./quota";

export const PHOTO_URL_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

export interface SolverPhotoDeps {
  authorize: () => Promise<ActionAuthorization>;
  db: SolverDb;
  store: () => ObjectStore;
  /** True when files live in the in-memory store (development, e2e): answer with the bytes. */
  inline: () => boolean;
}

const status = (code: number) => new Response(null, { status: code, headers: NO_STORE });

export async function handleSolverPhotoRequest(
  id: string,
  deps: SolverPhotoDeps,
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) return status(401);
  if (!UUID.test(id)) return status(404);
  const ownerId = authorization.data.userId;
  const sessionId = id.toLowerCase();
  try {
    const row = (
      await deps.db
        .select({ inputKey: solverSessions.inputKey })
        .from(solverSessions)
        .where(
          and(
            eq(solverSessions.id, sessionId),
            eq(solverSessions.ownerId, ownerId),
            isNull(solverSessions.deletedAt),
          ),
        )
        .limit(1)
    ).at(0);
    const key = parseSessionKey(ownerId, sessionId, row?.inputKey ?? null);
    if (!row?.inputKey || key?.stage !== "photo") return status(404);
    const store = deps.store();
    if (deps.inline()) {
      const bytes = await store.get(row.inputKey);
      if (!bytes) return status(404);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": mimeOfExt(key.ext),
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'inline; filename="photo"',
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    const url = await store.signedGetUrl(row.inputKey, PHOTO_URL_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { Location: url, ...NO_STORE, "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    logger.error(
      { module: "solver", err: safeErrorSummary(error) },
      "solver: could not serve a session photo",
    );
    return status(500);
  }
}
