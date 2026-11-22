import { describe, expect, it } from "vitest";
import { handleDevUpload, MAX_DEV_UPLOAD_BYTES } from "./dev-upload";
import { createMemoryStore } from "./memory";

const KEY = "materials/u1/m1/source.pdf";

async function signed() {
  const store = createMemoryStore({ uploadPath: "/api/dev/upload" });
  const path = await store.signedPutUrl(KEY, "application/pdf", 4, 60);
  return { store, url: `http://localhost:3000${path}` };
}

const put = (url: string, body: string, type = "application/pdf") =>
  new Request(url, {
    method: "PUT",
    body,
    headers: { "content-type": type, "content-length": String(body.length) },
  });

describe("handleDevUpload", () => {
  it("is a 404 when no memory store receives uploads (R2 or production)", async () => {
    const { url } = await signed();
    const response = await handleDevUpload(put(url, "%PDF"), () => null);
    expect(response.status).toBe(404);
  });

  it("stores a signed upload and refuses a mismatching one", async () => {
    const { store, url } = await signed();
    expect((await handleDevUpload(put(url, "%PDF-"), () => store)).status).toBe(403);
    expect(
      (await handleDevUpload(put(url, "%PDF", "text/html"), () => store)).status,
    ).toBe(403);
    expect(await store.get(KEY)).toBeNull();
    expect((await handleDevUpload(put(url, "%PDF"), () => store)).status).toBe(200);
    expect(await store.get(KEY)).not.toBeNull();
  });

  it("is 32 MB, larger than the largest signed upload", () => {
    expect(MAX_DEV_UPLOAD_BYTES).toBe(32 * 1024 * 1024);
    // The largest signed upload is a 25 MB material (pinned against the constant in the
    // materials upload tests, since src/lib cannot import features).
    expect(MAX_DEV_UPLOAD_BYTES).toBeGreaterThan(25 * 1024 * 1024);
  });

  it("refuses a body declared larger than any signed upload before reading it", async () => {
    const { store, url } = await signed();
    const request = new Request(url, {
      method: "PUT",
      body: "x",
      headers: { "content-length": String(MAX_DEV_UPLOAD_BYTES + 1) },
    });
    expect((await handleDevUpload(request, () => store)).status).toBe(413);
  });

  it("refuses a bad signature without reading the body", async () => {
    const { store, url } = await signed();
    const forged = new URL(url);
    forged.searchParams.set("signature", "00".repeat(32));
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new TextEncoder().encode("%PDF"));
          controller.close();
        },
      },
      // Nothing is pulled until someone reads.
      { highWaterMark: 0 },
    );
    const request = new Request(forged, {
      method: "PUT",
      body,
      headers: { "content-type": "application/pdf", "content-length": "4" },
      duplex: "half",
    } as RequestInit);
    expect((await handleDevUpload(request, () => store)).status).toBe(403);
    expect(read).toBe(false);
  });
});
