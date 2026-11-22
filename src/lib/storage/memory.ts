import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  assertContentLength,
  assertSafeDownloadName,
  assertSafeKey,
  assertSafePrefix,
  clampSeconds,
  type ObjectStore,
} from "./types";

export interface MemoryStore extends ObjectStore {
  /**
   * The key a PUT may write when its URL's signature, expiry, content type and `length` (the
   * declared Content-Length) all match; null otherwise. Lets the route refuse before reading.
   */
  checkSignedPut(
    params: URLSearchParams,
    contentType: string | null,
    length: number,
    now?: number,
  ): string | null;
  /**
   * Stores the body of a PUT to a URL that signedPutUrl issued (Ruling R2: the dev/e2e upload
   * route stands in for R2). Like R2 it checks the signature, the expiry, the content type and the
   * exact length; false (nothing stored) when any of them differs.
   */
  acceptSignedPut(
    params: URLSearchParams,
    contentType: string | null,
    body: Uint8Array,
    now?: number,
  ): boolean;
}

export interface MemoryStoreOptions {
  /**
   * Where signed PUT URLs point (a same-origin path such as "/api/dev/upload", so a browser can
   * upload in development and e2e). Without it they are placeholders on memory.invalid.
   */
  uploadPath?: string;
}

/** In-memory store for development and tests. Signed GET URLs are placeholders that carry the expiry. */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const objects = new Map<string, Uint8Array>();
  // Per store: a URL signed by one process cannot be replayed into another.
  const secret = randomBytes(32);
  const url = (key: string, params: Record<string, string>) =>
    `https://memory.invalid/${key}?${new URLSearchParams(params).toString()}`;
  const signature = (key: string, type: string, length: string, deadline: string) =>
    createHmac("sha256", secret)
      .update([key, type, length, deadline].join("\n"))
      .digest("hex");

  // Methods are async so an unsafe key rejects instead of throwing synchronously.
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async put(key, body) {
      assertSafeKey(key);
      objects.set(key, body.slice());
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(key) {
      assertSafeKey(key);
      return objects.get(key)?.slice() ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async delete(key) {
      assertSafeKey(key);
      objects.delete(key);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async deletePrefix(prefix) {
      assertSafePrefix(prefix);
      let count = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          count += 1;
        }
      }
      return count;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async signedGetUrl(key, seconds, options) {
      assertSafeKey(key);
      const name = options?.downloadName;
      if (name !== undefined) assertSafeDownloadName(name);
      return url(key, {
        expires: String(clampSeconds(seconds)),
        ...(name === undefined ? {} : { download: name }),
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async signedPutUrl(key, contentType, contentLength, seconds) {
      assertContentLength(contentLength);
      assertSafeKey(key);
      const expires = clampSeconds(seconds);
      const length = String(contentLength);
      const deadline = String(Date.now() + expires * 1000);
      const params = {
        expires: String(expires),
        type: contentType,
        length,
        deadline,
        signature: signature(key, contentType, length, deadline),
      };
      if (options.uploadPath === undefined) return url(key, params);
      return `${options.uploadPath}?${new URLSearchParams({ key, ...params }).toString()}`;
    },
    checkSignedPut(params, contentType, length, now = Date.now()) {
      const key = params.get("key") ?? "";
      const type = params.get("type") ?? "";
      const signedLength = params.get("length") ?? "";
      const deadline = params.get("deadline") ?? "";
      const given = Buffer.from(params.get("signature") ?? "", "hex");
      const expected = Buffer.from(signature(key, type, signedLength, deadline), "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        return null;
      if (!(Number(deadline) > now)) return null;
      if (contentType !== type || String(length) !== signedLength) return null;
      try {
        assertSafeKey(key);
      } catch {
        return null;
      }
      return key;
    },
    acceptSignedPut(params, contentType, body, now = Date.now()) {
      const key = this.checkSignedPut(params, contentType, body.length, now);
      if (key === null) return false;
      objects.set(key, body.slice());
      return true;
    },
  };
}
