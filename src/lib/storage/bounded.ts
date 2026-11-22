// A store whose every call fails after `ms` instead of waiting forever. Housekeeping (the trash
// purge, the export expiry purge) runs inside the daily jobs run: a call that never returns would
// hold the run past its function limit, so it becomes an ordinary failure of that one row
// (retried later). The R2 client has its own request timeout; this bound also covers any store.
import type { ObjectStore } from "./types";

export class StoreTimeoutError extends Error {
  constructor() {
    super("storage: an object store call took too long");
    this.name = "StoreTimeoutError";
  }
}

function within<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new StoreTimeoutError());
    }, ms);
  });
  return Promise.race([call, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** The same store with every call bounded by `ms`. */
export function boundObjectStore(store: ObjectStore, ms: number): ObjectStore {
  return {
    put: (key, body, contentType) => within(store.put(key, body, contentType), ms),
    get: (key) => within(store.get(key), ms),
    delete: (key) => within(store.delete(key), ms),
    deletePrefix: (prefix) => within(store.deletePrefix(prefix), ms),
    signedGetUrl: (key, seconds, options) =>
      within(store.signedGetUrl(key, seconds, options), ms),
    signedPutUrl: (key, type, length, seconds) =>
      within(store.signedPutUrl(key, type, length, seconds), ms),
  };
}
