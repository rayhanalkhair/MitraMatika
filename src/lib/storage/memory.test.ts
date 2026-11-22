import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("createMemoryStore", () => {
  it("round-trips an object and returns null for a missing key", async () => {
    const store = createMemoryStore();
    await store.put("exports/u1/a.pdf", bytes("halo"), "application/pdf");
    const got = await store.get("exports/u1/a.pdf");
    expect(got && new TextDecoder().decode(got)).toBe("halo");
    await expect(store.get("exports/u1/none.pdf")).resolves.toBeNull();
  });

  it("deletes one object", async () => {
    const store = createMemoryStore();
    await store.put("a/1", bytes("x"), "text/plain");
    await store.delete("a/1");
    await expect(store.get("a/1")).resolves.toBeNull();
  });

  it("deletePrefix removes only the prefix and returns the count", async () => {
    const store = createMemoryStore();
    await store.put("exports/u1/a", bytes("1"), "text/plain");
    await store.put("exports/u1/b", bytes("2"), "text/plain");
    await store.put("exports/u2/a", bytes("3"), "text/plain");
    await expect(store.deletePrefix("exports/u1/")).resolves.toBe(2);
    await expect(store.get("exports/u1/a")).resolves.toBeNull();
    await expect(store.get("exports/u2/a")).resolves.not.toBeNull();
  });

  it("returns a copy, so callers cannot mutate stored bytes", async () => {
    const store = createMemoryStore();
    await store.put("k/1", bytes("abc"), "text/plain");
    const first = await store.get("k/1");
    first![0] = 0;
    const second = await store.get("k/1");
    expect(new TextDecoder().decode(second!)).toBe("abc");
  });

  it("caps signed URL expiry at 300 seconds", async () => {
    const store = createMemoryStore();
    const url = await store.signedGetUrl("k/1", 99999);
    expect(new URL(url).searchParams.get("expires")).toBe("300");
    const put = await store.signedPutUrl("k/1", "image/png", 1000, 60);
    expect(new URL(put).searchParams.get("expires")).toBe("60");
  });

  it("carries the attachment name of a signed GET URL and refuses an unsafe one", async () => {
    const store = createMemoryStore();
    const url = await store.signedGetUrl("k/1", 60, { downloadName: "soal.pdf" });
    expect(new URL(url).searchParams.get("download")).toBe("soal.pdf");
    await expect(
      store.signedGetUrl("k/1", 60, { downloadName: 'x".pdf' }),
    ).rejects.toThrow();
  });

  it("rejects unsafe keys", async () => {
    const store = createMemoryStore();
    await expect(store.put("../x", bytes("1"), "text/plain")).rejects.toThrow();
    await expect(store.get("/abs")).rejects.toThrow();
  });
});

describe("createMemoryStore: signed PUT (dev/e2e upload route, Ruling R2)", () => {
  const put = async (uploadPath = "/api/dev/upload") => {
    const store = createMemoryStore({ uploadPath });
    const signed = await store.signedPutUrl(
      "materials/u1/m1/source.pdf",
      "application/pdf",
      4,
      60,
    );
    expect(signed.startsWith(`${uploadPath}?`)).toBe(true);
    const params = new URL(signed, "http://localhost").searchParams;
    return { store, params };
  };

  it("stores a body that matches the signed type and exact length", async () => {
    const { store, params } = await put();
    expect(store.acceptSignedPut(params, "application/pdf", bytes("%PDF"))).toBe(true);
    const got = await store.get("materials/u1/m1/source.pdf");
    expect(got && new TextDecoder().decode(got)).toBe("%PDF");
  });

  it("refuses another length, another type, a tampered key and an expired URL", async () => {
    const { store, params } = await put();
    expect(store.acceptSignedPut(params, "application/pdf", bytes("%PDF-"))).toBe(false);
    expect(store.acceptSignedPut(params, "image/png", bytes("%PDF"))).toBe(false);
    const forged = new URLSearchParams(params);
    forged.set("key", "materials/u2/m1/source.pdf");
    expect(store.acceptSignedPut(forged, "application/pdf", bytes("%PDF"))).toBe(false);
    const late = Number(params.get("deadline")) + 1;
    expect(store.acceptSignedPut(params, "application/pdf", bytes("%PDF"), late)).toBe(
      false,
    );
    expect(await store.get("materials/u1/m1/source.pdf")).toBeNull();
    expect(await store.get("materials/u2/m1/source.pdf")).toBeNull();
  });

  it("refuses a URL signed by another store", async () => {
    const { params } = await put();
    const other = createMemoryStore({ uploadPath: "/api/dev/upload" });
    expect(other.acceptSignedPut(params, "application/pdf", bytes("%PDF"))).toBe(false);
  });
});

describe("createMemoryStore: checkSignedPut (before any body is read)", () => {
  it("names the key for a matching signature, type and declared length, else null", async () => {
    const store = createMemoryStore({ uploadPath: "/api/dev/upload" });
    const signed = await store.signedPutUrl(
      "uploads/u1/m1/source.pdf",
      "application/pdf",
      4,
      60,
    );
    const params = new URL(signed, "http://localhost").searchParams;
    expect(store.checkSignedPut(params, "application/pdf", 4)).toBe(
      "uploads/u1/m1/source.pdf",
    );
    expect(store.checkSignedPut(params, "application/pdf", 5)).toBeNull();
    expect(store.checkSignedPut(params, "text/html", 4)).toBeNull();
    const forged = new URLSearchParams(params);
    forged.set("signature", "00".repeat(32));
    expect(store.checkSignedPut(forged, "application/pdf", 4)).toBeNull();
  });
});
