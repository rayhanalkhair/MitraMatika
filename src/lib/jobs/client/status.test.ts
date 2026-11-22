import { describe, expect, it, vi } from "vitest";
import {
  fetchJobStatus,
  JOB_STATUS_TIMEOUT_MS,
  isTerminal,
  nextPollInterval,
  parseJobStatus,
  pollIntervalFor,
  type JobStatusResult,
} from "./status";

const JOB = {
  id: "33333333-3333-4333-8333-333333333333",
  type: "generate_batch",
  status: "running",
  progress: { step: "draft", done: 1, total: 5, messageKey: "drafting" },
  error: null,
  runAfter: "2026-10-10T10:00:00.000Z",
  createdAt: "2026-10-10T09:59:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
};

describe("isTerminal", () => {
  it.each([
    ["queued", false],
    ["running", false],
    ["deferred", false],
    ["succeeded", true],
    ["failed", true],
    ["cancelled", true],
  ] as const)("%s -> %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});

describe("nextPollInterval", () => {
  it("polls every 2 s while queued or running", () => {
    expect(nextPollInterval("queued")).toBe(2000);
    expect(nextPollInterval("running")).toBe(2000);
  });

  it("polls every 15 s while deferred", () => {
    expect(nextPollInterval("deferred")).toBe(15000);
  });

  it("stops polling when the job is terminal", () => {
    expect(nextPollInterval("succeeded")).toBe(false);
    expect(nextPollInterval("failed")).toBe(false);
    expect(nextPollInterval("cancelled")).toBe(false);
  });
});

describe("pollIntervalFor", () => {
  const ok = (status: string): JobStatusResult => ({
    kind: "ok",
    job: parseJobStatus({ ...JOB, status }),
  });

  it("follows nextPollInterval for a loaded job", () => {
    expect(pollIntervalFor({ status: "success", data: ok("queued") })).toBe(2000);
    expect(pollIntervalFor({ status: "success", data: ok("deferred") })).toBe(15_000);
    expect(pollIntervalFor({ status: "success", data: ok("succeeded") })).toBe(false);
  });

  it("keeps polling every 15 s after an error", () => {
    expect(pollIntervalFor({ status: "error" })).toBe(15_000);
  });

  it("stops for signed-out, not-found and when there is no data yet", () => {
    expect(pollIntervalFor({ status: "success", data: { kind: "signed-out" } })).toBe(
      false,
    );
    expect(pollIntervalFor({ status: "success", data: { kind: "not-found" } })).toBe(
      false,
    );
    expect(pollIntervalFor({ status: "pending" })).toBe(false);
  });
});

describe("parseJobStatus", () => {
  it("accepts the whitelisted shape", () => {
    expect(parseJobStatus(JOB)).toEqual(JOB);
  });

  it("strips fields that are not part of the shape", () => {
    expect(parseJobStatus({ ...JOB, payload: { secret: 1 }, lockToken: "x" })).toEqual(
      JOB,
    );
  });

  it("accepts a failed job with an error code", () => {
    expect(
      parseJobStatus({ ...JOB, status: "failed", error: { code: "boom" } }).error,
    ).toEqual({
      code: "boom",
    });
  });

  it.each([
    ["an unknown status", { ...JOB, status: "paused" }],
    ["a missing id", { ...JOB, id: undefined }],
    ["a non-object", "nope"],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(() => parseJobStatus(value)).toThrow();
  });
});

describe("fetchJobStatus", () => {
  const respond = (init: { status?: number; body?: unknown; type?: ResponseType } = {}) =>
    vi.fn(() => {
      const response = new Response(JSON.stringify(init.body ?? JOB), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      });
      if (init.type) Object.defineProperty(response, "type", { value: init.type });
      return Promise.resolve(response);
    }) as unknown as typeof fetch;

  it("returns the parsed job on 200", async () => {
    expect(await fetchJobStatus(JOB.id, respond())).toEqual({ kind: "ok", job: JOB });
  });

  it.each([401, 403])("returns signed-out on %i", async (status) => {
    expect(await fetchJobStatus(JOB.id, respond({ status }))).toEqual({
      kind: "signed-out",
    });
  });

  it("returns signed-out when the proxy redirected to the sign-in page", async () => {
    expect(await fetchJobStatus(JOB.id, respond({ type: "opaqueredirect" }))).toEqual({
      kind: "signed-out",
    });
  });

  it("returns signed-out on a real 3xx status", async () => {
    expect(await fetchJobStatus(JOB.id, respond({ status: 303 }))).toEqual({
      kind: "signed-out",
    });
  });

  it("returns not-found on 404", async () => {
    expect(await fetchJobStatus(JOB.id, respond({ status: 404 }))).toEqual({
      kind: "not-found",
    });
  });

  it("throws on a server error so the query can retry", async () => {
    await expect(fetchJobStatus(JOB.id, respond({ status: 500 }))).rejects.toThrow();
  });

  it("requests the endpoint without following redirects", async () => {
    const fetchImpl = respond();
    await fetchJobStatus(JOB.id, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/jobs/${JOB.id}`,
      expect.objectContaining({ redirect: "manual", credentials: "same-origin" }),
    );
  });

  it("gives up on a request that never answers, so polling is not stuck behind it", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ) as unknown as typeof fetch;
      const outcome = fetchJobStatus(JOB.id, hung).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(JOB_STATUS_TIMEOUT_MS + 1);
      expect(await outcome).toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("also gives up when the response body never arrives", async () => {
    vi.useFakeTimers();
    try {
      const stalledBody = vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          type: "basic",
          status: 200,
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        } as unknown as Response),
      ) as unknown as typeof fetch;
      const outcome = fetchJobStatus(JOB.id, stalledBody).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(JOB_STATUS_TIMEOUT_MS + 1);
      expect(await outcome).toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });
});
