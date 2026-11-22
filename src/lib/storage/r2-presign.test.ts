import { describe, expect, it } from "vitest";
import { createR2Store } from "./r2";

// No mocks: the real SDK signs locally (no network). Guards the URL shape a real upload needs.
const store = createR2Store({
  accountId: "acct123",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  bucket: "mitramatika-app",
});

describe("createR2Store with the real presigner", () => {
  it("signs a PUT URL without checksum parameters, with content-length and a capped expiry", async () => {
    const url = new URL(
      await store.signedPutUrl("logos/u1/a.png", "image/png", 2048, 9999),
    );
    const names = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names.filter((n) => n.startsWith("x-amz-checksum"))).toEqual([]);
    expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
    const signed = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(signed).toContain("content-length");
    expect(signed).toContain("content-type");
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(300);
    expect(url.host.endsWith("acct123.r2.cloudflarestorage.com")).toBe(true);
  });

  it("signs a GET URL without any checksum parameter (also no checksum mode)", async () => {
    for (const options of [undefined, { downloadName: "soal.pdf" }]) {
      const url = new URL(await store.signedGetUrl("logos/u1/a.png", 60, options));
      const names = [...url.searchParams.keys()].map((k) => k.toLowerCase());
      // A browser download through R2 never validates a checksum: ask for none.
      expect(names.filter((n) => n.startsWith("x-amz-checksum"))).toEqual([]);
    }
  });
});
