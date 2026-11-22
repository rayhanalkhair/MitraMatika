// The stand-in for R2's presigned PUT in development and e2e (Ruling R2): the in-memory store's
// signed PUT URLs point here. Off (404, like an unknown route) unless the memory store is in use,
// which never happens in production. The signature in the URL authorises the upload, as on R2.
import type { MemoryStore } from "./memory";

/** Larger than any upload the app signs (materials: 25 MB; a test pins the relation). */
export const MAX_DEV_UPLOAD_BYTES = 32 * 1024 * 1024;

export async function handleDevUpload(
  request: Request,
  receiver: () => MemoryStore | null,
): Promise<Response> {
  const store = receiver();
  if (!store) return new Response(null, { status: 404 });
  const declared = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(declared) ||
    declared <= 0 ||
    declared > MAX_DEV_UPLOAD_BYTES
  ) {
    return new Response(null, { status: 413 });
  }
  const params = new URL(request.url).searchParams;
  const contentType = request.headers.get("content-type");
  // Signature, expiry, type and the declared length first: a refused upload is never read.
  if (store.checkSignedPut(params, contentType, declared) === null) {
    return new Response(null, { status: 403 });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  const accepted = store.acceptSignedPut(params, contentType, body);
  return new Response(null, { status: accepted ? 200 : 403 });
}
