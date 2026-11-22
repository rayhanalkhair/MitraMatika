import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  runAsUser: vi.fn(),
  revalidatePath: vi.fn(),
  scheduleRun: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  moveMaterial: vi.fn(),
  requestStructureProposal: vi.fn(),
  confirmStructure: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/db/client", () => ({ runAsUser: mocks.runAsUser }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../service/library", () => ({
  createFolder: mocks.createFolder,
  renameFolder: mocks.renameFolder,
  moveFolder: mocks.moveFolder,
  moveMaterial: mocks.moveMaterial,
}));
vi.mock("../service/structure", () => ({
  requestStructureProposal: mocks.requestStructureProposal,
  confirmStructure: mocks.confirmStructure,
}));

import { logger } from "@/lib/logger";
import { createFolderAction, moveFolderAction, renameFolderAction } from "./folders";
import { moveMaterialAction } from "./move-material";
import { confirmStructureAction, requestStructureAction } from "./structure";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const FOLDER = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.runAsUser.mockImplementation(
    (_db: unknown, _user: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ tx: true }),
  );
});

describe("folder actions", () => {
  it("refuse a signed-out caller before the database", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await createFolderAction({ name: "Kelas 8" })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(await renameFolderAction({ folderId: FOLDER, name: "x" })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(await moveFolderAction({ folderId: FOLDER, parentId: null })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
  });

  it("run as the signed-in teacher under RLS, never an owner from the client", async () => {
    mocks.createFolder.mockResolvedValue({ ok: true, data: { id: FOLDER } });
    expect(
      await createFolderAction({
        name: "Kelas 8",
        parentId: null,
        ownerId: OTHER,
      } as never),
    ).toEqual({ ok: true, id: FOLDER });
    expect(mocks.runAsUser.mock.calls[0][1]).toBe(USER.userId);
    expect(mocks.createFolder).toHaveBeenCalledWith(
      { tx: true },
      { ownerId: USER.userId, name: "Kelas 8", parentId: null },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/materials");

    mocks.moveFolder.mockResolvedValue({ ok: false, error: "nesting" });
    expect(await moveFolderAction({ folderId: FOLDER, parentId: ID })).toEqual({
      ok: false,
      error: "nesting",
    });
    mocks.renameFolder.mockResolvedValue({ ok: false, error: "retry" });
    expect(await renameFolderAction({ folderId: FOLDER, name: "Baru" })).toEqual({
      ok: false,
      error: "retry",
    });
  });

  it("answer generic to malformed input and to a crash, logging no SQL", async () => {
    expect(await createFolderAction({ name: 7 } as never)).toEqual({
      ok: false,
      error: "generic",
    });
    expect(await moveFolderAction({ folderId: "x", parentId: null })).toEqual({
      ok: false,
      error: "generic",
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.createFolder.mockRejectedValue(new Error("insert ... params: rahasia"));
    expect(await createFolderAction({ name: "Kelas 8" })).toEqual({
      ok: false,
      error: "generic",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("rahasia");
    error.mockRestore();
  });
});

describe("moveMaterialAction", () => {
  it("moves as the signed-in teacher and refreshes the list and the detail", async () => {
    mocks.moveMaterial.mockResolvedValue({ ok: true, data: undefined });
    expect(await moveMaterialAction({ materialId: ID, folderId: FOLDER })).toEqual({
      ok: true,
    });
    expect(mocks.moveMaterial).toHaveBeenCalledWith(
      { tx: true },
      { ownerId: USER.userId, materialId: ID, folderId: FOLDER },
    );
    expect(
      mocks.revalidatePath.mock.calls.map(([path]) => path as string).sort(),
    ).toEqual(["/materials", `/materials/${ID}`].sort());
    mocks.moveMaterial.mockResolvedValue({ ok: false, error: "folder" });
    expect(await moveMaterialAction({ materialId: ID, folderId: FOLDER })).toEqual({
      ok: false,
      error: "folder",
    });
  });
});

describe("requestStructureAction", () => {
  it("queues the proposal for the signed-in teacher and starts the runner", async () => {
    mocks.requestStructureProposal.mockResolvedValue({ ok: true, data: { jobId: "j1" } });
    expect(await requestStructureAction({ materialId: ID })).toEqual({
      ok: true,
      jobId: "j1",
    });
    expect(mocks.requestStructureProposal.mock.calls[0][1]).toMatchObject({
      ownerId: USER.userId,
      materialId: ID,
    });
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it("passes refusals through without starting anything", async () => {
    mocks.requestStructureProposal.mockResolvedValue({ ok: false, error: "notReady" });
    expect(await requestStructureAction({ materialId: ID })).toEqual({
      ok: false,
      error: "notReady",
    });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await requestStructureAction({ materialId: ID })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });
});

describe("confirmStructureAction", () => {
  const values = {
    title: "Matematika",
    grade: "8",
    academicYear: "2026/2027",
    chapters: [{ title: "Bab 1", pageStart: "1", pageEnd: "4", topicId: "" }],
  };
  const input = { materialId: ID, values };

  it("validates the typed values, saves as the signed-in teacher and refreshes", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: true, data: undefined });
    expect(await confirmStructureAction({ ...input, ownerId: OTHER })).toEqual({
      ok: true,
    });
    const call = mocks.confirmStructure.mock.calls[0][1] as {
      ownerId: string;
      input: unknown;
    };
    expect(call.ownerId).toBe(USER.userId);
    expect(call.input).toEqual({
      materialId: ID,
      title: "Matematika",
      grade: 8,
      academicYear: "2026/2027",
      chapters: [{ title: "Bab 1", pageStart: 1, pageEnd: 4, topicId: null }],
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/materials/${ID}`);
  });

  it("saves a structure with no chapters", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: true, data: undefined });
    expect(
      await confirmStructureAction({
        materialId: ID,
        values: { ...values, chapters: [] },
      }),
    ).toEqual({ ok: true });
  });

  it("refuses what the form refuses, before the database", async () => {
    for (const bad of [
      { ...input, values: { ...values, title: "  " } },
      { ...input, values: { ...values, academicYear: "2026/2030" } },
      { ...input, values: { ...values, grade: "10" } },
      {
        ...input,
        values: {
          ...values,
          chapters: [{ title: "Bab", pageStart: "5", pageEnd: "2", topicId: "" }],
        },
      },
      { materialId: "not-an-id", values },
      { materialId: ID },
      { ...values, materialId: ID },
    ]) {
      expect(await confirmStructureAction(bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect(mocks.confirmStructure).not.toHaveBeenCalled();
  });

  it("passes the typed refusal through", async () => {
    mocks.confirmStructure.mockResolvedValue({ ok: false, error: "pages" });
    expect(await confirmStructureAction(input)).toEqual({ ok: false, error: "pages" });
  });
});
