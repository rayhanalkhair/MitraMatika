import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class extends actual.S3Client {
      override send = send;
    },
  };
});

import { createMemoryStore } from "./memory";
import { createR2Store } from "./r2";
import type { ObjectStore } from "./types";

const r2 = () =>
  createR2Store({
    accountId: "acct",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    bucket: "b",
  });

const adapters: [string, () => ObjectStore][] = [
  ["memory", createMemoryStore],
  ["r2", r2],
];

beforeEach(() => {
  send.mockReset();
});

describe.each(adapters)("%s adapter guards", (_name, make) => {
  const bad = ["../x", "/abs", "a b", "a@b.co/x", ""];

  it.each(bad)("rejects the unsafe key %j in every method", async (key) => {
    const store = make();
    const body = new Uint8Array([1]);
    await expect(store.put(key, body, "text/plain")).rejects.toThrow();
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.delete(key)).rejects.toThrow();
    await expect(store.signedGetUrl(key, 60)).rejects.toThrow();
    await expect(store.signedPutUrl(key, "text/plain", 10, 60)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "/", "noslash", "../", "a//"])(
    "deletePrefix rejects %j (never wipes the bucket)",
    async (prefix) => {
      await expect(make().deletePrefix(prefix)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "signedPutUrl rejects the content length %s",
    async (length) => {
      await expect(make().signedPutUrl("k/1", "text/plain", length, 60)).rejects.toThrow(
        /ukuran/i,
      );
    },
  );
});
