import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  audit: vi.fn(() => Promise.resolve(true)),
  revalidatePath: vi.fn(),
  getObjectStore: vi.fn(() => "store"),
  trashAssessment: vi.fn(),
  restoreAssessment: vi.fn(),
  deleteAssessmentPermanently: vi.fn(),
  trashTemplate: vi.fn(),
  restoreTemplate: vi.fn(),
  deleteTemplatePermanently: vi.fn(),
  trashMaterial: vi.fn(),
  restoreMaterial: vi.fn(),
  deleteMaterialPermanently: vi.fn(),
  trashFolder: vi.fn(),
  restoreFolder: vi.fn(),
  deleteFolderPermanently: vi.fn(),
  trashSolverSession: vi.fn(),
  restoreSolverSession: vi.fn(),
  deleteSolverSessionPermanently: vi.fn(),
  scheduleRun: vi.fn(),
}));
vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/storage", () => ({ getObjectStore: mocks.getObjectStore }));
vi.mock("../service/assessment-trash", () => ({
  trashAssessment: mocks.trashAssessment,
  restoreAssessment: mocks.restoreAssessment,
  deleteAssessmentPermanently: mocks.deleteAssessmentPermanently,
}));
vi.mock("../service/template-trash", () => ({
  trashTemplate: mocks.trashTemplate,
  restoreTemplate: mocks.restoreTemplate,
  deleteTemplatePermanently: mocks.deleteTemplatePermanently,
}));
vi.mock("../service/material-trash", () => ({
  trashMaterial: mocks.trashMaterial,
  restoreMaterial: mocks.restoreMaterial,
  deleteMaterialPermanently: mocks.deleteMaterialPermanently,
  trashFolder: mocks.trashFolder,
  restoreFolder: mocks.restoreFolder,
  deleteFolderPermanently: mocks.deleteFolderPermanently,
}));
vi.mock("../service/solver-trash", () => ({
  trashSolverSession: mocks.trashSolverSession,
  restoreSolverSession: mocks.restoreSolverSession,
  deleteSolverSessionPermanently: mocks.deleteSolverSessionPermanently,
}));
vi.mock("@/lib/events", () => ({ audit: mocks.audit }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import {
  deleteAssessmentAction,
  restoreAssessmentAction,
  trashAssessmentAction,
} from "./assessment";
import {
  deleteFolderAction,
  deleteMaterialAction,
  restoreFolderAction,
  restoreMaterialAction,
  trashFolderAction,
  trashMaterialAction,
} from "./material";
import {
  deleteSolverSessionAction,
  restoreSolverSessionAction,
  trashSolverSessionAction,
} from "./solver";
import {
  deleteTemplateAction,
  restoreTemplateAction,
  trashTemplateAction,
} from "./template";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const ID = "22222222-2222-4222-8222-222222222222";

type Service = ReturnType<typeof vi.fn>;
interface Case {
  name: string;
  action: (raw: unknown) => Promise<unknown>;
  service: Service;
  args: Record<string, unknown>;
  withStore: boolean;
  data: unknown;
  audit: Record<string, unknown>;
  paths: string[];
}

const CASES: Case[] = [
  {
    name: "trashSolverSessionAction",
    action: trashSolverSessionAction,
    service: mocks.trashSolverSession,
    args: { ownerId: USER.userId, sessionId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "solver_session_trashed", entityType: "solver_session" },
    paths: ["/solve", `/solve/${ID}`, "/trash"],
  },
  {
    name: "restoreSolverSessionAction",
    action: restoreSolverSessionAction,
    service: mocks.restoreSolverSession,
    args: { ownerId: USER.userId, sessionId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "solver_session_untrashed", entityType: "solver_session" },
    paths: ["/trash", "/solve", `/solve/${ID}`],
  },
  {
    name: "deleteSolverSessionAction",
    action: deleteSolverSessionAction,
    service: mocks.deleteSolverSessionPermanently,
    args: { ownerId: USER.userId, sessionId: ID },
    withStore: true,
    data: { solutions: 2, files: 1 },
    audit: {
      action: "solver_session_deleted",
      entityType: "solver_session",
      metadata: { solutions: 2, files: 1 },
    },
    paths: ["/trash"],
  },
  {
    name: "trashAssessmentAction",
    action: trashAssessmentAction,
    service: mocks.trashAssessment,
    args: { ownerId: USER.userId, assessmentId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "assessment_trashed", entityType: "assessment" },
    paths: ["/assessment-builder", `/assessment-builder/${ID}`, "/trash", "/home"],
  },
  {
    name: "restoreAssessmentAction",
    action: restoreAssessmentAction,
    service: mocks.restoreAssessment,
    args: { ownerId: USER.userId, assessmentId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "assessment_untrashed", entityType: "assessment" },
    paths: ["/trash", "/assessment-builder", `/assessment-builder/${ID}`, "/home"],
  },
  {
    name: "deleteAssessmentAction",
    action: deleteAssessmentAction,
    service: mocks.deleteAssessmentPermanently,
    args: { ownerId: USER.userId, assessmentId: ID },
    withStore: true,
    data: { sections: 1, items: 3, exports: 7, exportFiles: 7, usages: 3 },
    audit: {
      action: "assessment_deleted",
      entityType: "assessment",
      metadata: { sections: 1, items: 3, exports: 7, exportFiles: 7, usages: 3 },
    },
    paths: ["/trash"],
  },
  {
    name: "trashTemplateAction",
    action: trashTemplateAction,
    service: mocks.trashTemplate,
    args: { ownerId: USER.userId, templateId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "template_trashed", entityType: "template" },
    paths: ["/settings", "/trash"],
  },
  {
    name: "restoreTemplateAction",
    action: restoreTemplateAction,
    service: mocks.restoreTemplate,
    args: { ownerId: USER.userId, templateId: ID },
    withStore: false,
    data: { defaultDropped: false },
    audit: { action: "template_untrashed", entityType: "template" },
    paths: ["/trash", "/settings"],
  },
  {
    name: "deleteTemplateAction",
    action: deleteTemplateAction,
    service: mocks.deleteTemplatePermanently,
    args: { ownerId: USER.userId, templateId: ID },
    withStore: true,
    data: { logoFiles: 1 },
    audit: {
      action: "template_deleted",
      entityType: "template",
      metadata: { logoFiles: 1 },
    },
    paths: ["/trash"],
  },
  {
    name: "trashMaterialAction",
    action: trashMaterialAction,
    service: mocks.trashMaterial,
    args: { ownerId: USER.userId, materialId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "material_trashed", entityType: "material" },
    paths: ["/materials", `/materials/${ID}`, "/trash"],
  },
  {
    name: "restoreMaterialAction",
    action: restoreMaterialAction,
    service: mocks.restoreMaterial,
    args: { ownerId: USER.userId, materialId: ID },
    withStore: false,
    data: { requeued: true },
    audit: { action: "material_untrashed", entityType: "material" },
    paths: ["/trash", "/materials", `/materials/${ID}`],
  },
  {
    name: "deleteMaterialAction",
    action: deleteMaterialAction,
    service: mocks.deleteMaterialPermanently,
    args: { ownerId: USER.userId, materialId: ID },
    withStore: true,
    data: { pages: 2, sections: 1, citations: 1, files: 3 },
    audit: {
      action: "material_deleted",
      entityType: "material",
      metadata: { pages: 2, sections: 1, citations: 1, files: 3 },
    },
    paths: ["/trash"],
  },
  {
    name: "trashFolderAction",
    action: trashFolderAction,
    service: mocks.trashFolder,
    args: { ownerId: USER.userId, folderId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "folder_trashed", entityType: "folder" },
    paths: ["/materials", "/trash"],
  },
  {
    name: "restoreFolderAction",
    action: restoreFolderAction,
    service: mocks.restoreFolder,
    args: { ownerId: USER.userId, folderId: ID },
    withStore: false,
    data: undefined,
    audit: { action: "folder_untrashed", entityType: "folder" },
    paths: ["/trash", "/materials"],
  },
  {
    name: "deleteFolderAction",
    action: deleteFolderAction,
    service: mocks.deleteFolderPermanently,
    args: { ownerId: USER.userId, folderId: ID },
    withStore: false,
    data: { subfolders: 0, materials: 2 },
    audit: {
      action: "folder_deleted",
      entityType: "folder",
      metadata: { subfolders: 0, materials: 2 },
    },
    paths: ["/trash"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
});

describe.each(CASES)("$name", (c) => {
  beforeEach(() => {
    c.service.mockResolvedValue({ ok: true, data: c.data });
  });

  it("answers signed_out without touching the database when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await c.action({ id: ID })).toEqual({ ok: false, reason: "signed_out" });
    expect(c.service).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before the database", async () => {
    for (const raw of [{ id: "x" }, null, "x", {}]) {
      expect(await c.action(raw)).toEqual({ ok: false, reason: "generic" });
    }
    expect(c.service).not.toHaveBeenCalled();
  });

  it("acts as the signed-in owner only, audits ids (and counts) only and refreshes the pages", async () => {
    expect(await c.action({ id: ID, ownerId: "someone-else" })).toEqual({ ok: true });
    const call = c.service.mock.calls[0] as unknown[];
    expect(call[0]).toEqual({ db: true });
    const input = (c.withStore ? call[2] : call[1]) as Record<string, unknown>;
    expect(input).toMatchObject(c.args);
    if (c.withStore) {
      // The store is handed over lazily.
      expect(mocks.getObjectStore).not.toHaveBeenCalled();
      expect((call[1] as () => unknown)()).toBe("store");
    }
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      entityId: ID,
      ...c.audit,
    });
    expect(
      mocks.revalidatePath.mock.calls.map(([path]) => path as string).sort(),
    ).toEqual([...c.paths].sort());
  });

  it.each([
    ["notFound", { ok: false, reason: "not_found" }],
    ["notInTrash", { ok: false, reason: "not_in_trash" }],
    [
      { code: "inUse", assessments: ["Ulangan Bab 1"] },
      { ok: false, reason: "in_use", assessments: ["Ulangan Bab 1"] },
    ],
  ])("maps %o to its reason and audits nothing", async (error, expected) => {
    c.service.mockResolvedValue({ ok: false, error });
    expect(await c.action({ id: ID })).toEqual(expected);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers generic and logs no SQL when the database or the store fails", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    c.service.mockRejectedValue(
      Object.assign(new Error("update ... params: secret title"), { code: "40001" }),
    );
    expect(await c.action({ id: ID })).toEqual({ ok: false, reason: "generic" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret title");
    expect(error.mock.calls[0][0]).toEqual({
      module: "trash",
      err: { name: "Error", code: "40001" },
    });
    error.mockRestore();
  });
});

describe("restoreMaterialAction and ingestion", () => {
  it("starts the runner when the restore queued the ingestion again, not otherwise", async () => {
    mocks.restoreMaterial.mockResolvedValue({ ok: true, data: { requeued: true } });
    expect(await restoreMaterialAction({ id: ID })).toEqual({ ok: true });
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
    mocks.restoreMaterial.mockResolvedValue({ ok: true, data: { requeued: false } });
    await restoreMaterialAction({ id: ID });
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it("still answers when the runner cannot be started here", async () => {
    mocks.scheduleRun.mockImplementation(() => {
      throw new Error("after() outside a request");
    });
    mocks.restoreMaterial.mockResolvedValue({ ok: true, data: { requeued: true } });
    expect(await restoreMaterialAction({ id: ID })).toEqual({ ok: true });
  });
});

describe("trashFolderAction on a folder that is not empty", () => {
  it("answers not_empty and changes nothing", async () => {
    mocks.trashFolder.mockResolvedValue({ ok: false, error: "notEmpty" });
    expect(await trashFolderAction({ id: ID })).toEqual({
      ok: false,
      reason: "not_empty",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("restoreTemplateAction with a taken default slot", () => {
  it("tells the client the template came back as a plain one", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
    mocks.restoreTemplate.mockResolvedValue({ ok: true, data: { defaultDropped: true } });
    expect(await restoreTemplateAction({ id: ID })).toEqual({
      ok: true,
      defaultDropped: true,
    });
  });
});
