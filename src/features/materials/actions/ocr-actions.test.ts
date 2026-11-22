import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  revalidatePath: vi.fn(),
  scheduleRun: vi.fn(),
  queueOcr: vi.fn(),
  prepareOcrUploads: vi.fn(),
  savePageText: vi.fn(),
  ocrPagesLeft: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
const tx = { tx: true };
vi.mock("@/lib/db/runtime", () => ({
  getDb: () => ({
    db: true,
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  }),
}));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => ({ store: true }) }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../service/ocr", () => ({
  queueOcr: mocks.queueOcr,
  prepareOcrUploads: mocks.prepareOcrUploads,
  savePageText: mocks.savePageText,
}));
vi.mock("../service/ocr-quota", () => ({ ocrPagesLeft: mocks.ocrPagesLeft }));

import { prepareOcrUploadsAction, queueOcrAction, savePageTextAction } from "./ocr";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.ocrPagesLeft.mockResolvedValue(12);
});

describe("OCR actions", () => {
  it("refuse a signed-out caller before any database work", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const out = { ok: false, error: "unauthenticated" };
    expect(await queueOcrAction({ materialId: ID, pageNos: [1] })).toEqual(out);
    expect(
      await prepareOcrUploadsAction({ materialId: ID, pages: [{ pageNo: 1, size: 10 }] }),
    ).toEqual(out);
    expect(await savePageTextAction({ materialId: ID, pageNo: 1, textMd: "x" })).toEqual(
      out,
    );
    expect(mocks.queueOcr).not.toHaveBeenCalled();
    expect(mocks.prepareOcrUploads).not.toHaveBeenCalled();
    expect(mocks.savePageText).not.toHaveBeenCalled();
  });

  it("queue as the signed-in teacher (never an owner from the client), then run the job", async () => {
    mocks.queueOcr.mockResolvedValue({
      ok: true,
      data: { jobId: "j", left: 18, pageNos: [1, 2] },
    });
    const result = await queueOcrAction({
      materialId: ID,
      pageNos: [2, 1],
      ownerId: OTHER,
    });
    expect(result).toEqual({ ok: true, left: 18, jobId: "j" });
    expect(mocks.queueOcr).toHaveBeenCalledWith(tx, {
      ownerId: USER.userId,
      materialId: ID,
      pageNos: [1, 2],
      now: expect.any(Date) as Date,
    });
    expect(mocks.scheduleRun).toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/materials/${ID}`);
  });

  it("pass the service's refusals through and refuse malformed input", async () => {
    mocks.queueOcr.mockResolvedValue({ ok: false, error: "limit" });
    expect(await queueOcrAction({ materialId: ID, pageNos: [1] })).toEqual({
      ok: false,
      error: "limit",
    });
    expect(await queueOcrAction({ materialId: "x", pageNos: [1] })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      await queueOcrAction({
        materialId: ID,
        pageNos: Array.from({ length: 21 }, (_, i) => i + 1),
      }),
    ).toEqual({ ok: false, error: "invalid" });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("sign uploads only within what is left today, for the signed-in teacher", async () => {
    mocks.prepareOcrUploads.mockResolvedValue({
      ok: true,
      data: { uploads: [{ pageNo: 1, url: "/u" }] },
    });
    expect(
      await prepareOcrUploadsAction({ materialId: ID, pages: [{ pageNo: 1, size: 10 }] }),
    ).toEqual({ ok: true, uploads: [{ pageNo: 1, url: "/u" }], left: 12 });
    expect(mocks.prepareOcrUploads).toHaveBeenCalledWith(
      { db: true, transaction: expect.any(Function) as unknown },
      { store: true },
      {
        ownerId: USER.userId,
        materialId: ID,
        pages: [{ pageNo: 1, size: 10 }],
        left: 12,
      },
    );
    expect(
      await prepareOcrUploadsAction({
        materialId: ID,
        pages: [{ pageNo: 1, size: 3_000_000 }],
      }),
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("save a correction as the signed-in teacher and refresh the material", async () => {
    mocks.savePageText.mockResolvedValue({ ok: true, data: undefined });
    expect(
      await savePageTextAction({ materialId: ID, pageNo: 3, textMd: "Teks" }),
    ).toEqual({
      ok: true,
    });
    expect(mocks.savePageText).toHaveBeenCalledWith(tx, {
      ownerId: USER.userId,
      materialId: ID,
      pageNo: 3,
      textMd: "Teks",
      now: expect.any(Date) as Date,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/materials/${ID}`);
    mocks.savePageText.mockResolvedValue({ ok: false, error: "notFound" });
    expect(
      await savePageTextAction({ materialId: ID, pageNo: 3, textMd: "Teks" }),
    ).toEqual({
      ok: false,
      error: "notFound",
    });
  });
});
