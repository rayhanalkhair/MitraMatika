import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AllowedUser } from "@/features/auth/service/access";
import type { PublicJobStatus } from "@/lib/jobs/status";
import {
  handleStatusRequest,
  KICK_INTERVAL_MS,
  kickThrottleSize,
  resetKickThrottle,
} from "./status-route";
import { logger } from "@/lib/logger";

const USER: AllowedUser = {
  status: "allowed",
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const JOB: PublicJobStatus = {
  id: JOB_ID,
  type: "generate_batch",
  status: "running",
  progress: { step: "draft", done: 1, total: 5 },
  error: null,
  runAfter: "2026-10-10T10:00:00.000Z",
  createdAt: "2026-10-10T09:59:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
};

const allowed = () => Promise.resolve({ ok: true as const, data: USER });

describe("handleStatusRequest", () => {
  it("returns 401 for an unauthenticated request without reading the job", async () => {
    const readJob = vi.fn();
    const response = await handleStatusRequest(JOB_ID, {
      authorize: () => Promise.resolve({ ok: false, error: "unauthenticated" }),
      readJob,
    });
    expect(response.status).toBe(401);
    expect(readJob).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for an id that is not a uuid without reading the job", async () => {
    const readJob = vi.fn();
    const response = await handleStatusRequest("../etc/passwd", {
      authorize: allowed,
      readJob,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(readJob).not.toHaveBeenCalled();
  });

  it("returns an identical 404 for a missing or foreign job", async () => {
    const response = await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: () => Promise.resolve(null),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the job for the signed-in user, reading as that user", async () => {
    const readJob = vi.fn(() => Promise.resolve(JOB));
    const response = await handleStatusRequest(JOB_ID, { authorize: allowed, readJob });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JOB);
    expect(readJob).toHaveBeenCalledWith(USER.userId, JOB_ID);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 500 with a generic body when reading fails", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const response = await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: () => {
        return Promise.reject(new Error("connection string leaked: postgres://x:y@z"));
      },
    });
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"error":"unavailable"}');
    error.mockRestore();
  });
});

describe("handleStatusRequest kick on poll", () => {
  beforeEach(() => {
    resetKickThrottle();
  });

  const readDue = (due: boolean) => () => Promise.resolve({ job: JOB, due });

  it("kicks once for a due job and leaves the response unchanged", async () => {
    const kick = vi.fn();
    const response = await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: readDue(true),
      kick,
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(JOB);
  });

  it("does not kick for a job that is not due", async () => {
    const kick = vi.fn();
    await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: readDue(false),
      kick,
    });
    expect(kick).not.toHaveBeenCalled();
  });

  it("never kicks for a missing or foreign job, or for a signed-out caller", async () => {
    const kick = vi.fn();
    const missing = await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: () => Promise.resolve(null),
      kick,
    });
    expect(missing.status).toBe(404);
    const signedOut = await handleStatusRequest(JOB_ID, {
      authorize: () => Promise.resolve({ ok: false, error: "unauthenticated" }),
      readJob: readDue(true),
      kick,
    });
    expect(signedOut.status).toBe(401);
    expect(kick).not.toHaveBeenCalled();
  });

  it("answers as usual and logs the error name once when the kick throws", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const response = await handleStatusRequest(JOB_ID, {
      authorize: allowed,
      readJob: readDue(true),
      kick: () => {
        throw new RangeError("secret detail");
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JOB);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).toContain("RangeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
    spy.mockRestore();
  });
});

describe("kick throttle", () => {
  beforeEach(() => {
    resetKickThrottle();
  });
  const OTHER_ID = "44444444-4444-4444-8444-444444444444";
  const poll = (job: PublicJobStatus, kick: () => void, now: number) =>
    handleStatusRequest(job.id, {
      authorize: allowed,
      readJob: () => Promise.resolve({ job, due: true }),
      kick,
      now: () => now,
    });

  it("kicks one job at most once per interval", async () => {
    const kick = vi.fn();
    await poll(JOB, kick, 1_000_000);
    const second = await poll(JOB, kick, 1_000_000 + KICK_INTERVAL_MS - 1);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(JOB);
  });

  it("kicks again once the interval has passed", async () => {
    const kick = vi.fn();
    await poll(JOB, kick, 1_000_000);
    await poll(JOB, kick, 1_000_000 + KICK_INTERVAL_MS);
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it("does not let two jobs throttle each other", async () => {
    const kick = vi.fn();
    await poll(JOB, kick, 1_000_000);
    await poll({ ...JOB, id: OTHER_ID }, kick, 1_000_001);
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it("prunes entries older than five minutes", async () => {
    const kick = vi.fn();
    await poll(JOB, kick, 1_000_000);
    await poll({ ...JOB, id: OTHER_ID }, kick, 1_000_001);
    expect(kickThrottleSize()).toBe(2);
    await poll(
      { ...JOB, id: "55555555-5555-4555-8555-555555555555" },
      kick,
      1_000_000 + 300_002,
    );
    expect(kickThrottleSize()).toBe(1);
  });
});
