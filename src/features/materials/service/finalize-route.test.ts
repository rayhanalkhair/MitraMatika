import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { handleFinalizeRequest, type FinalizeRouteDeps } from "./finalize-route";
import type { MaterialDb } from "./upload";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const KEY = `uploads/${USER.userId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/source.pdf`;
const URL_ = "https://mitramatika.test/api/materials/finalize";

const finalize = vi.fn();
const authorize = vi.fn();
const afterFinalize = vi.fn();

function deps(): FinalizeRouteDeps {
  return {
    authorize,
    db: { db: true } as unknown as MaterialDb,
    store: () => ({ store: true }) as unknown as ObjectStore,
    finalize,
    afterFinalize,
    now: () => new Date("2026-11-20T03:00:00.000Z"),
  };
}

function request(
  body: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://mitramatika.test",
      host: "mitramatika.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockResolvedValue({ ok: true, data: USER });
  finalize.mockResolvedValue({ ok: true, data: { materialId: "m1" } });
});

describe("POST /api/materials/finalize", () => {
  it("finalises as the signed-in teacher, never an owner from the body, then refreshes and runs ingestion", async () => {
    const response = await handleFinalizeRequest(
      request({
        objectKey: KEY,
        title: "Buku",
        ownerId: "22222222-2222-4222-8222-222222222222",
      }),
      deps(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, materialId: "m1" });
    expect(finalize.mock.calls[0][2]).toEqual({
      objectKey: KEY,
      title: "Buku",
      ownerId: USER.userId,
      now: new Date("2026-11-20T03:00:00.000Z"),
    });
    expect(afterFinalize).toHaveBeenCalledWith("m1");
  });

  it("answers 401 unauthenticated without touching storage when nobody is signed in", async () => {
    authorize.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const response = await handleFinalizeRequest(
      request({ objectKey: KEY, title: "Buku" }),
      deps(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthenticated" });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before reading the session", async () => {
    const cases: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "", origin: "https://evil.test" },
      { "sec-fetch-site": "", origin: "null" },
    ];
    for (const headers of cases) {
      const response = await handleFinalizeRequest(
        request({ objectKey: KEY, title: "Buku" }, headers),
        deps(),
      );
      expect(response.status).toBe(403);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, too large or malformed", async () => {
    const plain = await handleFinalizeRequest(
      request(null, { "content-type": "text/plain" }, "objectKey=x"),
      deps(),
    );
    expect(plain.status).toBe(415);
    const large = await handleFinalizeRequest(
      request({ objectKey: KEY, title: "x".repeat(20_000) }),
      deps(),
    );
    expect(large.status).toBe(413);
    // A declared length over the limit is refused before the body is read.
    const declared = request(
      { objectKey: KEY, title: "Buku" },
      { "content-length": "9000" },
    );
    const text = vi.spyOn(declared, "text");
    expect((await handleFinalizeRequest(declared, deps())).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    const broken = await handleFinalizeRequest(request(null, {}, "{not json"), deps());
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ ok: false, error: "generic" });
    const wrong = await handleFinalizeRequest(request({ objectKey: 3 }), deps());
    expect(wrong.status).toBe(400);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("passes the typed refusal through and does not refresh", async () => {
    finalize.mockResolvedValue({ ok: false, error: "encrypted" });
    const response = await handleFinalizeRequest(
      request({ objectKey: KEY, title: "Buku" }),
      deps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "encrypted" });
    expect(afterFinalize).not.toHaveBeenCalled();
  });

  it("answers generic and logs only the error name on a crash", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    finalize.mockRejectedValue(new Error("select ... params: secret title"));
    const response = await handleFinalizeRequest(
      request({ objectKey: KEY, title: "Buku" }),
      deps(),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "generic" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret title");
    error.mockRestore();
  });

  it("still answers when the follow-up (refresh, runner) throws", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    afterFinalize.mockImplementation(() => {
      throw new Error("after() outside a request");
    });
    const response = await handleFinalizeRequest(
      request({ objectKey: KEY, title: "Buku" }),
      deps(),
    );
    expect(await response.json()).toEqual({ ok: true, materialId: "m1" });
  });
});
