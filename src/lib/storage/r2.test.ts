import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  clientConfigs: [] as unknown[],
  clients: [] as unknown[],
  getSignedUrl:
    vi.fn<(client: unknown, command: unknown, options: unknown) => Promise<string>>(),
}));

// No real network: the SDK client and the presigner are replaced entirely.
vi.mock("@aws-sdk/client-s3", () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(public readonly input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      constructor(config: unknown) {
        mocks.clientConfigs.push(config);
        mocks.clients.push(this);
      }
      send = mocks.send;
    },
    PutObjectCommand: command("PutObject"),
    GetObjectCommand: command("GetObject"),
    DeleteObjectCommand: command("DeleteObject"),
    ListObjectsV2Command: command("ListObjectsV2"),
    DeleteObjectsCommand: command("DeleteObjects"),
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));

import { createR2Store } from "./r2";

const CONFIG = {
  accountId: "acct123",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  bucket: "mitramatika-app",
};

const sent = (index = 0) =>
  mocks.send.mock.calls[index][0] as { name: string; input: Record<string, unknown> };

beforeEach(() => {
  mocks.send.mockReset();
  mocks.getSignedUrl.mockReset();
  mocks.clientConfigs.length = 0;
  mocks.clients.length = 0;
});

describe("createR2Store", () => {
  it("points the client at the account endpoint with region auto", () => {
    createR2Store(CONFIG);
    expect(mocks.clientConfigs[0]).toMatchObject({
      region: "auto",
      endpoint: "https://acct123.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    });
  });

  it("bounds every storage request so a hung R2 call fails instead of stalling the caller", () => {
    createR2Store(CONFIG);
    expect(mocks.clientConfigs[0]).toMatchObject({
      requestHandler: {
        connectionTimeout: 10_000,
        requestTimeout: 30_000,
        throwOnRequestTimeout: true,
      },
    });
  });

  it("keeps the SDK checksum defaults on the request client and relaxes them only for presigning", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/x");
    const store = createR2Store(CONFIG);
    const [main, presign] = mocks.clientConfigs as Record<string, unknown>[];
    expect(mocks.clientConfigs).toHaveLength(2);
    expect(main).not.toHaveProperty("requestChecksumCalculation");
    expect(main).not.toHaveProperty("responseChecksumValidation");
    expect(presign).toMatchObject({
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    await store.signedGetUrl("k/1", 60);
    await store.signedPutUrl("k/1", "image/png", 10, 60);
    for (const call of mocks.getSignedUrl.mock.calls) {
      expect(call[0]).toBe(mocks.clients[1]);
    }
    mocks.send.mockResolvedValue({});
    await store.delete("k/1");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("put sends a PutObject with the bucket, key, body and content type", async () => {
    mocks.send.mockResolvedValue({});
    const body = new Uint8Array([1, 2, 3]);
    await createR2Store(CONFIG).put("exports/u1/a.pdf", body, "application/pdf");
    expect(sent().name).toBe("PutObject");
    expect(sent().input).toEqual({
      Bucket: "mitramatika-app",
      Key: "exports/u1/a.pdf",
      Body: body,
      ContentType: "application/pdf",
    });
  });

  it("get returns the bytes, and null when the object does not exist", async () => {
    mocks.send.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([9])) },
    });
    const store = createR2Store(CONFIG);
    await expect(store.get("k/1")).resolves.toEqual(new Uint8Array([9]));
    expect(sent().name).toBe("GetObject");
    mocks.send.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    await expect(store.get("k/2")).resolves.toBeNull();
    mocks.send.mockRejectedValueOnce(new Error("boom"));
    await expect(store.get("k/3")).rejects.toThrow("boom");
  });

  it("delete sends a DeleteObject", async () => {
    mocks.send.mockResolvedValue({});
    await createR2Store(CONFIG).delete("k/1");
    expect(sent().name).toBe("DeleteObject");
    expect(sent().input).toEqual({ Bucket: "mitramatika-app", Key: "k/1" });
  });

  it("deletePrefix lists page by page, deletes each batch and returns the total", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: "p/a" }, { Key: "p/b" }],
        IsTruncated: true,
        NextContinuationToken: "t1",
      })
      .mockResolvedValueOnce({}) // delete batch 1
      .mockResolvedValueOnce({ Contents: [{ Key: "p/c" }], IsTruncated: false })
      .mockResolvedValueOnce({}); // delete batch 2
    await expect(createR2Store(CONFIG).deletePrefix("p/")).resolves.toBe(3);
    expect(sent(0).name).toBe("ListObjectsV2");
    expect(sent(0).input).toMatchObject({ Bucket: "mitramatika-app", Prefix: "p/" });
    expect(sent(1).name).toBe("DeleteObjects");
    expect(sent(1).input).toMatchObject({
      Delete: { Objects: [{ Key: "p/a" }, { Key: "p/b" }], Quiet: true },
    });
    expect(sent(2).input).toMatchObject({ ContinuationToken: "t1" });
  });

  it("deletePrefix on an empty prefix deletes nothing", async () => {
    mocks.send.mockResolvedValueOnce({ IsTruncated: false });
    await expect(createR2Store(CONFIG).deletePrefix("none/")).resolves.toBe(0);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("deletePrefix throws when a batch reports errors", async () => {
    mocks.send
      .mockResolvedValueOnce({ Contents: [{ Key: "p/a" }], IsTruncated: false })
      .mockResolvedValueOnce({ Errors: [{ Key: "p/a", Code: "AccessDenied" }] });
    await expect(createR2Store(CONFIG).deletePrefix("p/")).rejects.toThrow(/p\/a/);
  });

  it("signs a GET URL with the expiry capped at 300 seconds", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    const url = await createR2Store(CONFIG).signedGetUrl("k/1", 3600);
    expect(url).toBe("https://signed.example/get");
    const [, command, options] = mocks.getSignedUrl.mock.calls[0];
    expect((command as { name: string }).name).toBe("GetObject");
    expect(options).toEqual({ expiresIn: 300 });
  });

  it("signs a GET URL that downloads as an attachment under a safe name", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    await createR2Store(CONFIG).signedGetUrl("k/1", 300, {
      downloadName: "ulangan-bab-1-naskah-soal.pdf",
    });
    const [, command] = mocks.getSignedUrl.mock.calls[0];
    const get = command as { name: string; input: Record<string, unknown> };
    expect(get.input).toEqual({
      Bucket: CONFIG.bucket,
      Key: "k/1",
      ResponseContentDisposition: 'attachment; filename="ulangan-bab-1-naskah-soal.pdf"',
    });
  });

  it("refuses a download name outside the safe character set", async () => {
    const store = createR2Store(CONFIG);
    for (const name of ['a".pdf', "a b.pdf", "ü.pdf", "../x.pdf", "", "a\r\nb.pdf"]) {
      await expect(
        store.signedGetUrl("k/1", 60, { downloadName: name }),
      ).rejects.toThrow();
    }
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it("signs a PUT URL bound to content type and size, expiry capped", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/put");
    await createR2Store(CONFIG).signedPutUrl("k/1", "image/png", 2048, 120);
    const [, command, options] = mocks.getSignedUrl.mock.calls[0];
    const put = command as { name: string; input: Record<string, unknown> };
    expect(put.name).toBe("PutObject");
    expect(put.input).toMatchObject({
      Bucket: "mitramatika-app",
      Key: "k/1",
      ContentType: "image/png",
      ContentLength: 2048,
    });
    expect(options).toMatchObject({ expiresIn: 120 });
    expect((options as { signableHeaders?: Set<string> }).signableHeaders).toEqual(
      new Set(["content-type", "content-length"]),
    );
  });

  it("refuses an unsafe key before any request", async () => {
    const store = createR2Store(CONFIG);
    await expect(store.get("../etc")).rejects.toThrow();
    await expect(store.signedGetUrl("/abs", 60)).rejects.toThrow();
    await expect(store.deletePrefix("noslash")).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
