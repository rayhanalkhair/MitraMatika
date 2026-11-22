// Where a session's photo lives: everything of one session sits under `solver/<ownerId>/<sessionId>/`
// (ids only, Ruling R13). The browser PUTs to `upload.<ext>` (the only key a URL is ever signed
// for); finalise copies the checked bytes to `photo.<ext>`, which no URL can replace (R11). The
// 7-day sweep, the trash purge and account deletion remove the whole prefix.
import { assertSafeKey, assertSafePrefix } from "@/lib/storage/types";
import { SOLVER_PHOTO_TYPES, type SolverPhotoMime } from "../schema/solver";

export type PhotoExt = (typeof SOLVER_PHOTO_TYPES)[SolverPhotoMime];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `solver/<ownerId>/<sessionId>/`; throws unless both are lower-case uuids. */
export function sessionPrefix(ownerId: string, sessionId: string): string {
  if (!UUID.test(ownerId) || !UUID.test(sessionId)) {
    throw new Error("solver: owner and session ids must be lower-case uuids");
  }
  const prefix = `solver/${ownerId}/${sessionId}/`;
  assertSafePrefix(prefix);
  return prefix;
}

function keyOf(ownerId: string, sessionId: string, name: string): string {
  const key = `${sessionPrefix(ownerId, sessionId)}${name}`;
  assertSafeKey(key);
  return key;
}

export const photoStagingKey = (ownerId: string, sessionId: string, ext: PhotoExt) =>
  keyOf(ownerId, sessionId, `upload.${ext}`);
export const photoKey = (ownerId: string, sessionId: string, ext: PhotoExt) =>
  keyOf(ownerId, sessionId, `photo.${ext}`);

/** The extension and stage of a key under this session's own prefix, or null for anything else. */
export function parseSessionKey(
  ownerId: string,
  sessionId: string,
  key: string | null,
): { stage: "upload" | "photo"; ext: PhotoExt } | null {
  if (key === null || !UUID.test(ownerId) || !UUID.test(sessionId)) return null;
  const match = /^(upload|photo)\.(png|jpg)$/.exec(
    key.startsWith(`solver/${ownerId}/${sessionId}/`)
      ? key.slice(`solver/${ownerId}/${sessionId}/`.length)
      : "",
  );
  if (!match) return null;
  return { stage: match[1] as "upload" | "photo", ext: match[2] as PhotoExt };
}

export const mimeOfExt = (ext: PhotoExt): SolverPhotoMime =>
  ext === "png" ? "image/png" : "image/jpeg";
