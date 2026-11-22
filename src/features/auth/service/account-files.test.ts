import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage/types";
import { deleteOwnerFiles, ownerFilePrefixes } from "./account-files";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

const bytes = new TextEncoder().encode("x");

async function seeded() {
  const store = createMemoryStore();
  const keys = [
    `templates/${OWNER}/${TEMPLATE}/logo.png`,
    `exports/${OWNER}/${JOB}/paper.pdf`,
    `exports/${OWNER}/${JOB}/all.zip`,
    `materials/${OWNER}/${JOB}/source.pdf`,
    `uploads/${OWNER}/${JOB}/source.pdf`,
    `solver/${OWNER}/${JOB}/photo.jpg`,
    `templates/${OTHER}/${TEMPLATE}/logo.png`,
    `exports/${OTHER}/${JOB}/paper.pdf`,
    `materials/${OTHER}/${JOB}/source.pdf`,
    `uploads/${OTHER}/${JOB}/source.pdf`,
    `solver/${OTHER}/${JOB}/photo.jpg`,
  ];
  for (const key of keys) await store.put(key, bytes, "application/octet-stream");
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ownerFilePrefixes", () => {
  it("names the owner's template, export, material, upload and solver folders, from a uuid only", () => {
    expect(ownerFilePrefixes(OWNER.toUpperCase())).toEqual([
      `templates/${OWNER}/`,
      `exports/${OWNER}/`,
      `materials/${OWNER}/`,
      `uploads/${OWNER}/`,
      `solver/${OWNER}/`,
    ]);
    for (const bad of ["", "guru@example.test", "../x", `${OWNER}/..`, "x".repeat(36)]) {
      expect(() => ownerFilePrefixes(bad), bad).toThrow();
    }
  });
});

describe("deleteOwnerFiles", () => {
  it("deletes the owner's logos, exports, materials, uploads and solver photos and nothing of anyone else, logging counts only", async () => {
    const store = await seeded();
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    expect(await deleteOwnerFiles(() => store, OWNER)).toEqual({ deleted: 6, failed: 0 });
    expect(await store.get(`solver/${OWNER}/${JOB}/photo.jpg`)).toBeNull();
    expect(await store.get(`solver/${OTHER}/${JOB}/photo.jpg`)).not.toBeNull();
    expect(await store.get(`templates/${OWNER}/${TEMPLATE}/logo.png`)).toBeNull();
    expect(await store.get(`exports/${OWNER}/${JOB}/paper.pdf`)).toBeNull();
    expect(await store.get(`materials/${OWNER}/${JOB}/source.pdf`)).toBeNull();
    expect(await store.get(`uploads/${OWNER}/${JOB}/source.pdf`)).toBeNull();
    expect(await store.get(`materials/${OTHER}/${JOB}/source.pdf`)).not.toBeNull();
    expect(await store.get(`uploads/${OTHER}/${JOB}/source.pdf`)).not.toBeNull();
    expect(await store.get(`templates/${OTHER}/${TEMPLATE}/logo.png`)).not.toBeNull();
    expect(await store.get(`exports/${OTHER}/${JOB}/paper.pdf`)).not.toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatchObject({
      module: "settings",
      deleted: 6,
      failed: 0,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(OWNER);
  });

  it("logs and returns a storage failure or a timeout instead of throwing", async () => {
    const store = await seeded();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failing: ObjectStore = {
      ...store,
      deletePrefix: (prefix) =>
        prefix.startsWith("templates/")
          ? Promise.reject(new Error("R2 unavailable"))
          : new Promise<number>(() => undefined),
    };
    expect(await deleteOwnerFiles(() => failing, OWNER, { timeoutMs: 20 })).toEqual({
      deleted: 0,
      failed: 5,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ module: "settings", failed: 5 });
    expect(JSON.stringify(error.mock.calls)).not.toContain(OWNER);
  });

  it("does not throw when no object store is configured, nor for a malformed id", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const unconfigured = () => {
      throw new Error("Penyimpanan berkas belum diatur");
    };
    expect(await deleteOwnerFiles(unconfigured, OWNER)).toEqual({
      deleted: 0,
      failed: 5,
    });
    const store = await seeded();
    const spy = vi.spyOn(store, "deletePrefix");
    expect(await deleteOwnerFiles(() => store, "not-a-uuid")).toEqual({
      deleted: 0,
      failed: 5,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
