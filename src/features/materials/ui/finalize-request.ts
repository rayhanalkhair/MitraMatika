// The browser's half of step 2 of an upload: POSTs the key and title to the finalise route
// (a route handler, Ruling R16) and reads back the same typed answer the Server Action gave.
import type { FinalizeUploadState, UploadErrorKey } from "../schema/upload";

export const FINALIZE_PATH = "/api/materials/finalize";

function isState(value: unknown): value is FinalizeUploadState {
  if (typeof value !== "object" || value === null) return false;
  const body = value as { ok?: unknown; materialId?: unknown; error?: unknown };
  return body.ok === true
    ? typeof body.materialId === "string"
    : body.ok === false && typeof body.error === "string";
}

/** Finalises one upload; a network failure is `network`, an unreadable answer `generic`. */
export async function requestFinalize(input: {
  objectKey: string;
  title: string;
  folderId?: string;
}): Promise<FinalizeUploadState> {
  let response: Response;
  try {
    response = await fetch(FINALIZE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  // Signed out: the proxy answers with a redirect to /sign-in, which fetch follows to its page.
  if (response.redirected) return { ok: false, error: "unauthenticated" };
  try {
    const body: unknown = await response.json();
    if (isState(body)) return body;
  } catch {
    // Not JSON: fall through.
  }
  const error: UploadErrorKey = response.status === 401 ? "unauthenticated" : "generic";
  return { ok: false, error };
}
