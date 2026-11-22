import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SLOT_WAIT_MS,
  MAX_SLOT_WAIT_MS,
  MAX_SLOT_WAITERS,
  runBoundedWorker,
  type WorkerLike,
} from "./bounded-worker";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
const LIMITS = {
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  stackSizeMb: 4,
};
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const owner = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

/** A worker that never answers; its terminate() resolves only when `dies` is true. */
function stubbornWorker(dies = false): WorkerLike {
  const worker = Object.assign(new EventEmitter(), {
    stdout: { resume: () => undefined },
    stderr: { resume: () => undefined },
    terminate: () => (dies ? Promise.resolve(0) : new Promise<number>(() => undefined)),
  });
  return worker;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runBoundedWorker", () => {
  it("returns the worker's answer and transfers the buffer", async () => {
    const bytes = new Uint8Array(1024).buffer;
    const result = await runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_A,
      data: { value: "halo", bytes },
      transfer: [bytes],
      timeoutMs: 10_000,
      resourceLimits: LIMITS,
    });
    expect(result).toEqual({ ok: true, value: { echo: "halo", bytes: 1024 } });
  });

  it("terminates a worker that runs past its time limit", async () => {
    const started = Date.now();
    const result = await runBoundedWorker(fixture("spin.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 300,
      resourceLimits: LIMITS,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a worker killed by its heap limit as a crash, and the caller lives on", async () => {
    const before = process.memoryUsage().rss;
    const result = await runBoundedWorker(fixture("allocate.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 20_000,
      resourceLimits: LIMITS,
    });
    expect(result).toEqual({ ok: false, reason: "crash" });
    // The worker's heap died with it; the calling process grew by far less than unbounded.
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
  });
});

describe("the process-wide parse slot (R29)", () => {
  it("runs one parse at a time: a second owner's run starts after the first ends", async () => {
    const run = (ownerId: string) =>
      runBoundedWorker<{ started: number; ended: number }>(fixture("sleep.worker.mjs"), {
        ownerId,
        data: { ms: 300 },
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      });
    const [first, second] = await Promise.all([run(OWNER_A), run(OWNER_B)]);
    if (!first.ok || !second.ok) throw new Error("a run failed");
    const [early, late] = [first.value, second.value].sort(
      (a, b) => a.started - b.started,
    );
    expect(late.started).toBeGreaterThanOrEqual(early.ended);
  });

  it("answers busy when the slot is not free in time, and frees it on every path", async () => {
    const long = runBoundedWorker(fixture("spin.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 600,
      resourceLimits: LIMITS,
    });
    const waiting = runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_B,
      data: { value: "x", bytes: new ArrayBuffer(1) },
      timeoutMs: 10_000,
      waitMs: 100,
      resourceLimits: LIMITS,
    });
    expect(await waiting).toEqual({ ok: false, reason: "busy" });
    expect(await long).toEqual({ ok: false, reason: "timeout" });
    const after = await runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_B,
      data: { value: "y", bytes: new ArrayBuffer(2) },
      timeoutMs: 10_000,
      waitMs: 1_000,
      resourceLimits: LIMITS,
    });
    expect(after).toEqual({ ok: true, value: { echo: "y", bytes: 2 } });
    expect(
      await runBoundedWorker(fixture("allocate.worker.mjs"), {
        ownerId: OWNER_A,
        data: {},
        timeoutMs: 20_000,
        resourceLimits: LIMITS,
      }),
    ).toEqual({ ok: false, reason: "crash" });
    expect(
      await runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: OWNER_A,
        data: { value: "z", bytes: new ArrayBuffer(3) },
        timeoutMs: 10_000,
        waitMs: 1_000,
        resourceLimits: LIMITS,
      }),
    ).toEqual({ ok: true, value: { echo: "z", bytes: 3 } });
  });

  it("releases the slot when a worker never dies (terminate hangs)", async () => {
    const stuck = await runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 50,
      terminateGraceMs: 50,
      resourceLimits: LIMITS,
      createWorker: () => stubbornWorker(),
    });
    expect(stuck).toEqual({ ok: false, reason: "timeout" });
    const next = await runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_B,
      data: { value: "w", bytes: new ArrayBuffer(4) },
      timeoutMs: 10_000,
      waitMs: 1_000,
      resourceLimits: LIMITS,
    });
    expect(next).toEqual({ ok: true, value: { echo: "w", bytes: 4 } });
  });

  it("prepares the bytes only once the slot is held, and never for a refused run", async () => {
    const held = runBoundedWorker(fixture("spin.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 300,
      resourceLimits: LIMITS,
    });
    const prepare = vi.fn(() => ({ data: { value: "p", bytes: new ArrayBuffer(5) } }));
    expect(
      await runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: OWNER_B,
        payload: prepare,
        timeoutMs: 10_000,
        waitMs: 50,
        resourceLimits: LIMITS,
      }),
    ).toEqual({ ok: false, reason: "busy" });
    expect(prepare).not.toHaveBeenCalled();
    await held;
    expect(
      await runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: OWNER_B,
        payload: prepare,
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      }),
    ).toEqual({ ok: true, value: { echo: "p", bytes: 5 } });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("lets a teacher wait behind their own parse once, and refuses a third or a fifth waiter (R31)", async () => {
    expect(MAX_SLOT_WAITERS).toBe(4);
    const run = (ownerId: string, ms: number) =>
      runBoundedWorker<{ started: number; ended: number }>(fixture("sleep.worker.mjs"), {
        ownerId,
        data: { ms },
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      });
    const first = run(OWNER_A, 200);
    // Two files dropped at once: the second waits behind the first and then runs.
    const second = run(OWNER_A, 50);
    const started = Date.now();
    // A third of the same teacher has no place left: refused at once.
    expect(await run(OWNER_A, 50)).toEqual({ ok: false, reason: "busy" });
    const queued = [1, 2, 3].map((n) =>
      runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: owner(n),
        data: { value: String(n), bytes: new ArrayBuffer(n) },
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      }),
    );
    // Four are waiting (A's second and three others): a fifth is refused at once.
    expect(
      await runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: owner(5),
        data: {},
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      }),
    ).toEqual({ ok: false, reason: "busy" });
    expect(Date.now() - started).toBeLessThan(300);
    const [a1, a2] = await Promise.all([first, second]);
    if (!a1.ok || !a2.ok) throw new Error("a run of the same teacher failed");
    expect(a2.value.started).toBeGreaterThanOrEqual(a1.value.ended);
    expect((await Promise.all(queued)).map((result) => result.ok)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("does not let a teacher's own queue starve another teacher (owners take turns)", async () => {
    const order: string[] = [];
    const run = (ownerId: string, label: string) =>
      runBoundedWorker(fixture("sleep.worker.mjs"), {
        ownerId,
        data: { ms: 100 },
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      }).then((result) => {
        if (result.ok) order.push(label);
        return result;
      });
    const a1 = run(OWNER_A, "A1");
    const a2 = run(OWNER_A, "A2");
    const b1 = run(OWNER_B, "B1");
    await Promise.all([a1, a2, b1]);
    // A queued first, but B goes before A's second parse.
    expect(order).toEqual(["A1", "B1", "A2"]);
  });

  it("waits at most MAX_SLOT_WAIT_MS whatever the caller asks, and 10 s by default", async () => {
    expect(DEFAULT_SLOT_WAIT_MS).toBe(10_000);
    vi.useFakeTimers();
    const held = runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 10 * MAX_SLOT_WAIT_MS,
      terminateGraceMs: 10,
      resourceLimits: LIMITS,
      createWorker: () => stubbornWorker(true),
    });
    const waiting = runBoundedWorker(fixture("echo.worker.mjs"), {
      ownerId: OWNER_B,
      data: {},
      timeoutMs: 1_000,
      waitMs: 10 * MAX_SLOT_WAIT_MS,
      resourceLimits: LIMITS,
      createWorker: () => stubbornWorker(true),
    });
    await vi.advanceTimersByTimeAsync(MAX_SLOT_WAIT_MS + 1);
    expect(await waiting).toEqual({ ok: false, reason: "busy" });
    await vi.advanceTimersByTimeAsync(10 * MAX_SLOT_WAIT_MS);
    expect(await held).toEqual({ ok: false, reason: "timeout" });
  });

  it("never queues a run that may not wait: a flood of them leaves room for real parses", async () => {
    const held = runBoundedWorker(fixture("spin.worker.mjs"), {
      ownerId: OWNER_A,
      data: {},
      timeoutMs: 400,
      resourceLimits: LIMITS,
    });
    // In the same tick: eight try-only runs (like the dependency probe), then four real parses.
    const probes = Array.from({ length: 8 }, (_, n) =>
      runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: owner(100 + n),
        data: {},
        timeoutMs: 1_000,
        waitMs: 0,
        resourceLimits: LIMITS,
      }),
    );
    const real = [1, 2, 3, 4].map((n) =>
      runBoundedWorker(fixture("echo.worker.mjs"), {
        ownerId: owner(n),
        data: { value: String(n), bytes: new ArrayBuffer(n) },
        timeoutMs: 10_000,
        resourceLimits: LIMITS,
      }),
    );
    expect((await Promise.all(probes)).map((result) => result.ok)).toEqual(
      Array.from({ length: 8 }, () => false),
    );
    await held;
    expect((await Promise.all(real)).map((result) => result.ok)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
