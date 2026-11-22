import type { ViewerFormat } from "@/lib/format-date";
import { describe, expect, it } from "vitest";
import { createStaticTranslator } from "@/lib/i18n/translator";
import { describeJobStatus, formatResumeTime } from "./status-message";

const t = createStaticTranslator("generate.status");
const view: ViewerFormat = { locale: "id", timeZone: "Asia/Jakarta" };
const status = (
  job: Parameters<typeof describeJobStatus>[0],
  now?: Date,
): ReturnType<typeof describeJobStatus> => describeJobStatus(job, t, view, now);

const NOW = new Date("2026-10-11T07:00:00.000Z");

const job = (over: Record<string, unknown> = {}) => ({
  status: "queued" as const,
  progress: null,
  error: null,
  runAfter: "2026-10-11T07:30:00.000Z",
  ...over,
});

describe("formatResumeTime", () => {
  it("formats the time in Asia/Jakarta as HH.MM", () => {
    expect(formatResumeTime("2026-10-11T07:30:00.000Z", view)).toBe("14.30");
    expect(formatResumeTime("2026-10-11T17:05:00.000Z", view)).toBe("00.05");
  });

  it("follows the viewer's timezone and locale", () => {
    const utc: ViewerFormat = { locale: "id", timeZone: "UTC" };
    expect(formatResumeTime("2026-10-11T07:30:00.000Z", utc)).toBe("07.30");
    expect(
      formatResumeTime("2026-10-11T07:30:00.000Z", { locale: "en", timeZone: "UTC" }),
    ).toBe("07:30");
    expect(
      formatResumeTime("2026-10-11T17:05:00.000Z", {
        locale: "id",
        timeZone: "Asia/Jayapura",
      }),
    ).toBe("02.05");
  });
});

describe("describeJobStatus", () => {
  it("queued waits for its turn", () => {
    expect(status(job())).toMatchObject({
      tone: "info",
      title: "Menunggu giliran",
    });
  });

  it("running shows step progress when present", () => {
    expect(
      status(job({ status: "running", progress: { step: "draft", done: 2, total: 5 } })),
    ).toMatchObject({
      tone: "info",
      title: "Soal sedang dibuat",
      detail: "Langkah 2 dari 5",
    });
  });

  it("running without progress has no detail", () => {
    expect(status(job({ status: "running" })).detail).toBeUndefined();
  });

  it("deferred shows the plan's resume message with the Jakarta time", () => {
    const message = status(job({ status: "deferred" }), NOW);
    expect(message.tone).toBe("waiting");
    expect(message.title).toBe(
      "Kuota AI harian habis. Pekerjaan dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    );
  });

  it("succeeded is a success with the next-stage note", () => {
    expect(status(job({ status: "succeeded" }))).toMatchObject({
      tone: "success",
      title: "Selesai",
    });
  });

  it("failed with unknown_job_type says generation is not available yet", () => {
    expect(
      status(job({ status: "failed", error: { code: "unknown_job_type" } })),
    ).toMatchObject({ tone: "error", detail: "Pembuatan soal belum tersedia." });
  });

  it("failed with any other code falls back to a generic message and hides the code", () => {
    const message = status(job({ status: "failed", error: { code: "handler_error" } }));
    expect(message.tone).toBe("error");
    expect(message.detail).toBe("Terjadi kesalahan saat membuat soal. Coba lagi nanti.");
    expect(JSON.stringify(message)).not.toContain("handler_error");
  });

  it("cancelled is reported as such", () => {
    expect(status(job({ status: "cancelled" })).title).toBe("Dibatalkan");
  });

  it("ignores malformed progress", () => {
    expect(
      status(job({ status: "running", progress: { done: "x" } })).detail,
    ).toBeUndefined();
  });
});

describe("deferral reasons", () => {
  const RUN_AFTER = "2026-10-11T07:30:00.000Z"; // 14.30 in Asia/Jakarta

  it.each([
    [
      "quota_daily",
      "Kuota AI harian habis. Pekerjaan dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    ],
    [
      "quota_minute",
      "Menunggu giliran layanan AI. Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    ],
    [
      "provider_rate_limited",
      "Layanan AI sedang membatasi permintaan. Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    ],
  ])("shows the copy for %s", (messageKey, title) => {
    const message = status(
      {
        status: "deferred",
        progress: { step: "deferred", done: 0, total: 5, messageKey },
        error: null,
        runAfter: RUN_AFTER,
      },
      NOW,
    );
    expect(message).toEqual({ tone: "waiting", title });
  });

  it("falls back to the daily wording for an unknown or missing key", () => {
    for (const progress of [
      null,
      { step: "deferred", done: 0, total: 5, messageKey: "other" },
    ]) {
      const message = status(
        { status: "deferred", progress, error: null, runAfter: RUN_AFTER },
        NOW,
      );
      expect(message.title).toContain("Kuota AI harian habis");
    }
  });

  it("says it resumes soon, without a past time, once the resume time has passed", () => {
    for (const messageKey of ["quota_daily", "quota_minute", "provider_rate_limited"]) {
      const base = {
        status: "deferred" as const,
        progress: { step: "deferred", done: 0, total: 5, messageKey },
        error: null,
        runAfter: RUN_AFTER,
      };
      const after = new Date("2026-10-11T07:31:00.000Z");
      expect(status(base, after)).toEqual({
        tone: "waiting",
        title: "Segera dilanjutkan",
      });
      // Exactly at the resume time counts as due.
      expect(status(base, new Date(RUN_AFTER)).title).toBe("Segera dilanjutkan");
      // A moment before it still shows the time.
      expect(status(base, new Date("2026-10-11T07:29:59.000Z")).title).toContain("14.30");
    }
  });
});

describe("failure reasons", () => {
  const failed = (code: string) =>
    status({
      status: "failed",
      progress: null,
      error: { code },
      runAfter: "2026-10-11T07:30:00.000Z",
    });

  it.each([
    [
      "provider_unavailable",
      "Layanan AI sedang tidak dapat dijangkau. Coba lagi beberapa saat lagi.",
    ],
    [
      "provider_misconfigured",
      "Layanan AI belum diatur dengan benar. Hubungi pengelola aplikasi.",
    ],
    ["provider_busy", "Layanan AI masih membatasi permintaan. Coba lagi nanti."],
    ["invalid_output", "Jawaban AI belum bisa dipakai. Coba buat lagi."],
    [
      "structural_failed",
      "Soal yang dibuat belum memenuhi pemeriksaan otomatis. Coba buat lagi.",
    ],
    ["persist_failed", "Soal belum dapat disimpan. Coba lagi nanti."],
    [
      "material_unrelated",
      "Halaman materi yang dipilih tidak membahas topik ini. Pilih halaman atau topik lain.",
    ],
    [
      "material_unavailable",
      "Materi sumber tidak dapat dipakai lagi (dihapus atau diubah). Buat permintaan baru.",
    ],
    ["unknown_job_type", "Pembuatan soal belum tersedia."],
    ["something_else", "Terjadi kesalahan saat membuat soal. Coba lagi nanti."],
  ])("maps %s", (code, detail) => {
    expect(failed(code)).toEqual({
      tone: "error",
      title: "Soal belum dapat dibuat",
      detail,
    });
  });

  it("keeps the generic copy when there is no error code", () => {
    expect(
      status({ status: "failed", progress: null, error: null, runAfter: "x" }),
    ).toMatchObject({ detail: "Terjadi kesalahan saat membuat soal. Coba lagi nanti." });
  });
});
