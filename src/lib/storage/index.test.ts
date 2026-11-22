import { afterEach, describe, expect, it, vi } from "vitest";

const R2_VARS = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_APP_BUCKET: "bucket",
};

async function load() {
  vi.resetModules();
  return import("./index");
}

function setEnv(values: Record<string, string>, nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  for (const key of Object.keys(R2_VARS)) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getObjectStore", () => {
  it("importing the module never throws, even in production without R2 variables", async () => {
    setEnv({}, "production");
    await expect(load()).resolves.toBeDefined();
  });

  it("throws only on first use in production without R2 variables", async () => {
    setEnv({}, "production");
    const { getObjectStore } = await load();
    expect(() => getObjectStore()).toThrow(/R2_/);
  });

  it("throws in production when only some R2 variables are set", async () => {
    setEnv({ R2_ACCOUNT_ID: "acct" }, "production");
    const { getObjectStore } = await load();
    expect(() => getObjectStore()).toThrow(/R2_/);
  });

  it("throws for any NODE_ENV other than development or test, undefined included", async () => {
    for (const nodeEnv of ["staging", "preview", ""]) {
      setEnv({}, nodeEnv);
      const { getObjectStore } = await load();
      expect(() => getObjectStore(), `NODE_ENV=${nodeEnv}`).toThrow(/R2_/);
    }
    setEnv({}, "test");
    vi.stubEnv("NODE_ENV", undefined);
    const { getObjectStore } = await load();
    expect(() => getObjectStore()).toThrow(/R2_/);
  });

  it("reuses the R2 client while the credentials are unchanged and rebuilds it on any change, a rotated secret included", async () => {
    setEnv(R2_VARS, "production");
    const { getObjectStore } = await load();
    const first = getObjectStore();
    expect(getObjectStore()).toBe(first);
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "rotated-secret");
    const second = getObjectStore();
    expect(second).not.toBe(first);
    expect(getObjectStore()).toBe(second);
    vi.stubEnv("R2_APP_BUCKET", "other-bucket");
    expect(getObjectStore()).not.toBe(second);
  });

  it("returns a shared in-memory store in test and development", async () => {
    setEnv({}, "test");
    const { getObjectStore } = await load();
    const store = getObjectStore();
    await store.put("a/1", new Uint8Array([1]), "text/plain");
    await expect(getObjectStore().get("a/1")).resolves.toEqual(new Uint8Array([1]));
    setEnv({}, "development");
    await getObjectStore().put("a/2", new Uint8Array([2]), "text/plain");
    await expect(getObjectStore().get("a/2")).resolves.toEqual(new Uint8Array([2]));
  });

  it("returns the R2 adapter when all four variables are set", async () => {
    setEnv(R2_VARS, "production");
    const { getObjectStore } = await load();
    const store = getObjectStore();
    // R2 signs locally, so a URL comes back with no network call.
    const url = await store.signedGetUrl("exports/u1/a.pdf", 60);
    expect(url).toContain("acct.r2.cloudflarestorage.com");
    expect(url).toContain("X-Amz-Expires=60");
  });
});

describe("getMemoryUploadReceiver", () => {
  it("is the memory store in test and development, null with R2 or in production", async () => {
    setEnv({}, "test");
    let mod = await load();
    const store = mod.getObjectStore();
    expect(mod.getMemoryUploadReceiver()).toBe(store);
    const url = await store.signedPutUrl("a/1", "text/plain", 1, 60);
    expect(url.startsWith(`${mod.DEV_UPLOAD_PATH}?`)).toBe(true);

    setEnv(R2_VARS, "development");
    mod = await load();
    expect(mod.getMemoryUploadReceiver()).toBeNull();

    setEnv({}, "production");
    mod = await load();
    expect(mod.getMemoryUploadReceiver()).toBeNull();
  });
});

describe("the development store", () => {
  it("survives a module reload (dev server HMR, separate route and action graphs)", async () => {
    setEnv({}, "development");
    const first = await load();
    await first
      .getObjectStore()
      .put("uploads/u1/x/source.pdf", new Uint8Array([7]), "x/y");
    const second = await load();
    expect(second.getObjectStore()).toBe(first.getObjectStore());
    await expect(second.getObjectStore().get("uploads/u1/x/source.pdf")).resolves.toEqual(
      new Uint8Array([7]),
    );
  });
});
