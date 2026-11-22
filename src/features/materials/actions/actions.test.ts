import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  startUpload: vi.fn(),
  cancelUpload: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => ({ store: true }) }));
vi.mock("../service/upload", () => ({
  startUpload: mocks.startUpload,
  cancelUpload: mocks.cancelUpload,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import { cancelUploadAction } from "./cancel-upload";
import { startUploadAction } from "./start-upload";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const KEY = `materials/${USER.userId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/source.pdf`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
});

describe("startUploadAction", () => {
  it("refuses a signed-out caller before touching storage", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(
      await startUploadAction({ fileName: "a.pdf", declaredType: "", size: 1 }),
    ).toEqual({ ok: false, error: "unauthenticated" });
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("starts the upload for the signed-in teacher, never an owner from the client", async () => {
    mocks.startUpload.mockResolvedValue({
      ok: true,
      data: { uploadUrl: "/u", objectKey: KEY, contentType: "application/pdf" },
    });
    const result = await startUploadAction({
      fileName: "a.pdf",
      declaredType: "application/pdf",
      size: 10,
      ownerId: "22222222-2222-4222-8222-222222222222",
    } as never);
    expect(result).toEqual({
      ok: true,
      uploadUrl: "/u",
      objectKey: KEY,
      contentType: "application/pdf",
    });
    expect(mocks.startUpload.mock.calls[0][2]).toMatchObject({
      ownerId: USER.userId,
      fileName: "a.pdf",
      declaredType: "application/pdf",
      size: 10,
    });
  });

  it("maps a refusal, malformed input and a crash to typed errors", async () => {
    mocks.startUpload.mockResolvedValue({ ok: false, error: "quota" });
    expect(
      await startUploadAction({ fileName: "a.pdf", declaredType: "", size: 1 }),
    ).toEqual({
      ok: false,
      error: "quota",
    });
    expect(await startUploadAction({ fileName: 3, size: "x" } as never)).toEqual({
      ok: false,
      error: "generic",
    });
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.startUpload.mockRejectedValue(new Error("db down"));
    expect(
      await startUploadAction({ fileName: "a.pdf", declaredType: "", size: 1 }),
    ).toEqual({
      ok: false,
      error: "generic",
    });
  });
});

describe("cancelUploadAction", () => {
  it("refuses a signed-out caller", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await cancelUploadAction({ objectKey: KEY })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(mocks.cancelUpload).not.toHaveBeenCalled();
  });

  it("cancels as the signed-in teacher only", async () => {
    mocks.cancelUpload.mockResolvedValue({ ok: true, data: undefined });
    expect(await cancelUploadAction({ objectKey: KEY })).toEqual({ ok: true });
    expect(mocks.cancelUpload.mock.calls[0][2]).toMatchObject({
      ownerId: USER.userId,
      objectKey: KEY,
    });
    mocks.cancelUpload.mockResolvedValue({ ok: false, error: "notFound" });
    expect(await cancelUploadAction({ objectKey: KEY })).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(await cancelUploadAction({ objectKey: 5 } as never)).toEqual({
      ok: false,
      error: "generic",
    });
  });
});
