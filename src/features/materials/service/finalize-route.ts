import "server-only";
// POST /api/materials/finalize: step 2 of an upload, as a route handler (Ruling R16). Finalise
// parses the uploaded file in a worker thread (R10, R15), and Next traces the emitted worker files
// only into route handlers, not into pages, so a Server Action hosted by /materials would find no
// worker on Vercel and reject every PDF as damaged.
//
// The same guarantees as the Server Action it replaces: the session is checked by the
// authoritative guard (`authorizeAction`), the owner comes from the session only, the input is
// validated with the same zod schema and the answer is the same typed `FinalizeUploadState`.
// Server Actions also get Next's origin check; a route handler does not, so this one refuses a
// cross-site request itself (Sec-Fetch-Site, else Origin against the host) and accepts JSON only
// (a cross-site form cannot send it without a CORS preflight, which this route never answers).
import { logger } from "@/lib/logger";
import type { ActionAuthorization } from "@/features/auth";
import type { ObjectStore } from "@/lib/storage/types";
import { finalizeUploadSchema, type FinalizeUploadState } from "../schema/upload";
import type { finalizeUpload, MaterialDb } from "./upload";

/** The request is a key and a title: anything larger is not a finalise. */
const MAX_BODY_CHARS = 8_192;
const NO_STORE = { "Cache-Control": "no-store" };

export interface FinalizeRouteDeps {
  authorize: () => Promise<ActionAuthorization>;
  db: MaterialDb;
  store: () => ObjectStore;
  finalize: typeof finalizeUpload;
  /** After a material is created: refresh the materials page and start the runner (ingestion). */
  afterFinalize: (materialId: string) => void;
  now?: () => Date;
}

const reply = (body: FinalizeUploadState, status = 200) =>
  Response.json(body, { status, headers: NO_STORE });

/** Whether the browser says the request came from this site (no header: not a browser). */
function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function handleFinalizeRequest(
  request: Request,
  deps: FinalizeRouteDeps,
): Promise<Response> {
  if (!isSameOrigin(request)) return reply({ ok: false, error: "generic" }, 403);
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return reply({ ok: false, error: "generic" }, 415);
  }
  const authorization = await deps.authorize();
  if (!authorization.ok) return reply({ ok: false, error: "unauthenticated" }, 401);

  // A declared length over the limit is refused without reading the body.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_CHARS) {
    return reply({ ok: false, error: "generic" }, 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return reply({ ok: false, error: "generic" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply({ ok: false, error: "generic" }, 400);
  }
  const parsed = finalizeUploadSchema.safeParse(raw);
  if (!parsed.success) return reply({ ok: false, error: "generic" }, 400);

  let result: Awaited<ReturnType<typeof finalizeUpload>>;
  try {
    result = await deps.finalize(deps.db, deps.store(), {
      ...parsed.data,
      ownerId: authorization.data.userId,
      now: (deps.now ?? (() => new Date()))(),
    });
  } catch (error) {
    logger.error(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not finalise an upload",
    );
    return reply({ ok: false, error: "generic" }, 500);
  }
  if (!result.ok) return reply({ ok: false, error: result.error });
  try {
    deps.afterFinalize(result.data.materialId);
  } catch (error) {
    // The material exists; the status poll or the daily run reads it if the runner could not be started here.
    logger.warn(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not schedule the ingestion after a finalise",
    );
  }
  return reply({ ok: true, materialId: result.data.materialId });
}
