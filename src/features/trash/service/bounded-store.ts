// A store whose every call fails after `ms` instead of waiting forever. The trash deletes files
// inside a row's transaction: a call that never returns would hold that row's lock and the jobs
// daily run, so it is turned into an ordinary failure of that one row (rolled back, retried later).
// The bound itself lives in @/lib/storage/bounded (the export expiry purge uses it too).
import { boundObjectStore } from "@/lib/storage/bounded";
import type { StoreSource } from "./assessment-trash";

export { StoreTimeoutError } from "@/lib/storage/bounded";

/** The same store source, with every call bounded by `ms`. */
export function boundedStore(source: StoreSource, ms: number): StoreSource {
  return () => boundObjectStore(source(), ms);
}
