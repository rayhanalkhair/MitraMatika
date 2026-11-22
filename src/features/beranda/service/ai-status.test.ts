import type { ViewerFormat } from "@/lib/format-date";
import { describe, expect, it } from "vitest";
import type { RunningItem } from "@/features/beranda/service/dashboard";
import { createStaticTranslator } from "@/lib/i18n/translator";
import { aiStatus, jobMessage } from "./ai-status";

const t = createStaticTranslator("generate.status");
const view: ViewerFormat = { locale: "id", timeZone: "Asia/Jakarta" };
const message = (item: RunningItem, now?: Date) => jobMessage(item, t, view, now);

const NOW = new Date("2026-11-08T06:00:00.000Z");

const item = (over: Partial<RunningItem> = {}): RunningItem => ({
  requestId: "11111111-1111-4111-8111-111111111111",
  topicTitle: "Bilangan Bulat",
  quantity: 5,
  createdAt: "2026-11-08T05:00:00.000Z",
  jobStatus: "running",
  runAfter: null,
  progress: null,
  messageKey: null,
  ...over,
});

describe("aiStatus", () => {
  it("is ready for an empty list", () => {
    expect(aiStatus([])).toEqual({ kind: "ready" });
  });

  it("is working for queued or running jobs", () => {
    expect(aiStatus([item({ jobStatus: "queued" })]).kind).toBe("working");
    expect(aiStatus([item()]).kind).toBe("working");
  });

  it("deferred beats running and leaves the resume time to its running row", () => {
    const deferred = item({
      jobStatus: "deferred",
      runAfter: "2026-11-08T07:30:00.000Z",
      messageKey: "quota_minute",
    });
    const result = aiStatus([item(), deferred]);
    expect(result).toEqual({ kind: "waiting" });
    expect(message(deferred, NOW).title).toContain("14.30");
  });

  it("is the same once the resume time has passed: the row says it resumes soon", () => {
    const deferred = item({
      jobStatus: "deferred",
      runAfter: "2026-11-08T07:30:00.000Z",
    });
    const late = new Date("2026-11-08T08:00:00.000Z");
    expect(aiStatus([deferred])).toEqual({ kind: "waiting" });
    expect(message(deferred, late).title).toBe("Segera dilanjutkan");
  });

  it("does not throw on a deferred job without a resume time", () => {
    expect(aiStatus([item({ jobStatus: "deferred" })]).kind).toBe("waiting");
  });
});

describe("jobMessage", () => {
  it("shows progress for a running job", () => {
    const m = message(item({ progress: { done: 1, total: 3 } }));
    expect(m.title).toBe("Soal sedang dibuat");
    expect(m.detail).toBe("Langkah 1 dari 3");
  });

  it("falls back to the queue text for a deferred job without a time", () => {
    expect(message(item({ jobStatus: "deferred" })).title).toBe("Menunggu giliran");
  });
});
