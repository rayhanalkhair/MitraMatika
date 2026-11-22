import { createHash } from "node:crypto";
import "server-only";
import { getEnv } from "@/lib/env";
import { createMemoryStore, type MemoryStore } from "./memory";
import { createR2Store } from "./r2";
import type { ObjectStore } from "./types";

export type { ObjectStore } from "./types";
export { MAX_SIGNED_SECONDS } from "./types";

/** Where the in-memory store's signed PUT URLs point (src/app/api/dev/upload/route.ts). */
export const DEV_UPLOAD_PATH = "/api/dev/upload";

let cached: { signature: string; store: ObjectStore } | undefined;

// The development/test store and its signing secret live on globalThis: the dev server may
// evaluate this module more than once (HMR, the route handler and Server Action graphs), and an
// upload signed by one copy must land where finalise reads.
type GlobalWithStore = typeof globalThis & { __mitramatikaMemoryStore?: MemoryStore };
function memoryStore(): MemoryStore {
  const holder = globalThis as GlobalWithStore;
  holder.__mitramatikaMemoryStore ??= createMemoryStore({ uploadPath: DEV_UPLOAD_PATH });
  return holder.__mitramatikaMemoryStore;
}

/**
 * R2 when all four R2 variables are set. Without them, a shared in-memory store only when NODE_ENV
 * is "development" or "test"; any other value (production, staging, unset) throws. The throw
 * happens here on first use, never on import, so a deploy that does not use files yet still
 * boots. Read lazily on every call; the client is cached and rebuilt when the account, key id,
 * secret (compared by hash) or bucket changes.
 */
export function getObjectStore(): ObjectStore {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_APP_BUCKET } =
    getEnv();
  const complete =
    R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_APP_BUCKET;

  if (!complete) {
    // Memory only on a positive local signal; any other value (production, staging, unset)
    // must not silently keep files in process memory.
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      throw new Error(
        "Penyimpanan berkas belum diatur: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY dan R2_APP_BUCKET harus terisi kecuali NODE_ENV development atau test. Lihat docs/operations/runbook.md.",
      );
    }
    cached = cached?.signature === "memory" ? cached : undefined;
    cached ??= { signature: "memory", store: memoryStore() };
    return cached.store;
  }

  // The secret enters only as a hash, so a secret-only rotation rebuilds the client.
  const secretHash = createHash("sha256").update(R2_SECRET_ACCESS_KEY).digest("hex");
  const signature = [R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, secretHash, R2_APP_BUCKET].join(
    "|",
  );
  if (cached?.signature !== signature) {
    cached = {
      signature,
      store: createR2Store({
        accountId: R2_ACCOUNT_ID,
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
        bucket: R2_APP_BUCKET,
      }),
    };
  }
  return cached.store;
}

/**
 * The in-memory store that receives browser uploads (Ruling R2), or null whenever uploads go to
 * R2 or NODE_ENV is anything but development or test. The literal NODE_ENV check folds to null
 * in a production bundle.
 */
export function getMemoryUploadReceiver(): MemoryStore | null {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test")
    return null;
  let store: ObjectStore;
  try {
    store = getObjectStore();
  } catch {
    return null;
  }
  return cached?.signature === "memory" && store === memoryStore() ? memoryStore() : null;
}
