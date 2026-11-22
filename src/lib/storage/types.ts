/** Longest lifetime of any signed URL, in seconds. */
export const MAX_SIGNED_SECONDS = 300;

const MAX_KEY_LENGTH = 512;
// Segments of ids, dots, dashes and underscores joined by single slashes. No spaces, no
// non-ASCII and no "@": a key can never carry a person's name or email address.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /**
   * Removes every object under the prefix (which must end in "/"); returns how many.
   * Not atomic: it deletes batch by batch, and if a batch fails it throws without reporting what
   * was already removed. Deleting is idempotent, so calling it again is safe.
   */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * With `downloadName` the response carries `Content-Disposition: attachment` under that name,
   * which must pass assertSafeDownloadName (ASCII letters, digits, dot, minus, underscore).
   */
  signedGetUrl(key: string, seconds: number, options?: SignedGetOptions): Promise<string>;
  /**
   * Signs an upload that must be EXACTLY `contentLength` bytes of `contentType` (both are part of
   * the signature; this is not a maximum). The type is only what the client declared: callers
   * must still check the real content after the upload.
   */
  signedPutUrl(
    key: string,
    contentType: string,
    contentLength: number,
    seconds: number,
  ): Promise<string>;
}

export interface SignedGetOptions {
  downloadName?: string;
}

// A file name that needs no quoting or encoding in a Content-Disposition header.
const DOWNLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Throws unless the name is 1-120 ASCII letters, digits, dots, minus signs or underscores. */
export function assertSafeDownloadName(name: string): void {
  if (!DOWNLOAD_NAME.test(name) || name.includes("..")) {
    throw new Error("Nama berkas unduhan tidak valid.");
  }
}

/** The attachment header for a name that passed assertSafeDownloadName. */
export function attachmentDisposition(name: string): string {
  assertSafeDownloadName(name);
  return `attachment; filename="${name}"`;
}

function assertSegments(path: string, what: string): void {
  if (path.length === 0 || path.length > MAX_KEY_LENGTH) {
    throw new Error(`Kunci penyimpanan tidak valid (${what}): panjang harus 1-512.`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SEGMENT.test(segment)) {
      throw new Error(
        `Kunci penyimpanan tidak valid (${what}): hanya huruf, angka, titik, minus, garis bawah dan satu garis miring antarsegmen.`,
      );
    }
  }
}

/** Throws unless the key is safe: no "..", no leading or trailing slash, limited charset. */
export function assertSafeKey(key: string): void {
  assertSegments(key, "key");
}

/** A prefix is a safe key body followed by a single trailing slash. */
export function assertSafePrefix(prefix: string): void {
  if (!prefix.endsWith("/")) {
    throw new Error("Prefiks penyimpanan harus diakhiri garis miring.");
  }
  assertSegments(prefix.slice(0, -1), "prefix");
}

/** Caps a requested lifetime at MAX_SIGNED_SECONDS and rejects non-positive values. */
export function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Masa berlaku URL bertanda tangan harus lebih dari 0 detik.");
  }
  return Math.min(Math.floor(seconds), MAX_SIGNED_SECONDS);
}

/** The exact upload size must be a positive whole number of bytes. */
export function assertContentLength(length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error("Ukuran unggahan harus berupa bilangan bulat byte lebih dari 0.");
  }
}
