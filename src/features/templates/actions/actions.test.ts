import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  saveTemplate: vi.fn(),
  setDefaultTemplate: vi.fn(),
  uploadLogo: vi.fn(),
  revalidatePath: vi.fn(),
  runAsUser: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/db/client", () => ({ runAsUser: mocks.runAsUser }));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => ({ store: true }) }));
vi.mock("../service/templates", async () => ({
  ...(await vi.importActual<object>("../service/templates")),
  saveTemplate: mocks.saveTemplate,
  setDefaultTemplate: mocks.setDefaultTemplate,
}));
vi.mock("../service/logo", async () => ({
  ...(await vi.importActual<object>("../service/logo")),
  uploadLogo: mocks.uploadLogo,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import { saveTemplateAction } from "./save-template";
import { setDefaultTemplateAction } from "./set-default-template";
import { uploadLogoAction } from "./upload-logo";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TX = { tx: true };

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
const VALID_FORM = {
  name: "Kop utama",
  schoolName: "SMP 2",
  headerLine0: "Dinas Pendidikan",
  paperSize: "A4",
  font: "times",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.runAsUser.mockImplementation((_db, _user, fn: (tx: unknown) => unknown) =>
    fn(TX),
  );
  mocks.saveTemplate.mockResolvedValue({
    ok: true,
    data: { id: TEMPLATE_ID, rowVersion: 2 },
  });
  mocks.setDefaultTemplate.mockResolvedValue({ ok: true, data: undefined });
  mocks.uploadLogo.mockResolvedValue({ ok: true, data: { logoKey: "k" } });
});

describe("saveTemplateAction", () => {
  it("creates a template for the signed-in teacher only, under RLS", async () => {
    const state = await saveTemplateAction(
      {},
      form({ ...VALID_FORM, ownerId: "someone-else" }),
    );
    expect(mocks.runAsUser).toHaveBeenCalledWith(
      { db: true },
      USER.userId,
      expect.any(Function),
    );
    expect(mocks.saveTemplate).toHaveBeenCalledTimes(1);
    const [tx, request] = mocks.saveTemplate.mock.calls[0] as [
      unknown,
      {
        ownerId: string;
        templateId?: string;
        expectedRowVersion?: number;
        input: object;
      },
    ];
    expect(tx).toBe(TX);
    expect(request.ownerId).toBe(USER.userId);
    expect(request.templateId).toBeUndefined();
    expect(request.expectedRowVersion).toBeUndefined();
    expect(request.input).toMatchObject({
      schoolName: "SMP 2",
      headerLines: ["Dinas Pendidikan"],
    });
    expect(state.savedAt).toEqual(expect.any(Number));
    expect(state.templateId).toBe(TEMPLATE_ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("updates with the template id and row version from the form", async () => {
    await saveTemplateAction(
      {},
      form({ ...VALID_FORM, templateId: TEMPLATE_ID, expectedRowVersion: "3" }),
    );
    expect(mocks.saveTemplate).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ templateId: TEMPLATE_ID, expectedRowVersion: 3 }),
    );
  });

  it("returns field errors without touching the database", async () => {
    const state = await saveTemplateAction({}, form({ ...VALID_FORM, schoolName: " " }));
    expect(state.fieldErrors).toEqual({ schoolName: "required" });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
  });

  it("re-checks every field with the form's schema: header lines by their own input, an unknown paper size", async () => {
    const state = await saveTemplateAction(
      {},
      form({
        ...VALID_FORM,
        headerLine1: "x".repeat(121),
        paperSize: "A3",
      }),
    );
    expect(state.fieldErrors).toEqual({ headerLine1: "tooLong", paperSize: "invalid" });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
  });

  it("maps another teacher's template to not found and a stale row version to conflict", async () => {
    mocks.saveTemplate.mockResolvedValueOnce({ ok: false, error: "notFound" });
    expect(
      await saveTemplateAction(
        {},
        form({ ...VALID_FORM, templateId: TEMPLATE_ID, expectedRowVersion: "1" }),
      ),
    ).toEqual({ error: "notFound" });
    mocks.saveTemplate.mockResolvedValueOnce({ ok: false, error: "conflict" });
    expect(
      await saveTemplateAction(
        {},
        form({ ...VALID_FORM, templateId: TEMPLATE_ID, expectedRowVersion: "1" }),
      ),
    ).toEqual({ error: "conflict" });
  });

  it("refuses a malformed template id or row version", async () => {
    expect(
      await saveTemplateAction(
        {},
        form({ ...VALID_FORM, templateId: "../x", expectedRowVersion: "1" }),
      ),
    ).toEqual({ error: "notFound" });
    expect(
      await saveTemplateAction({}, form({ ...VALID_FORM, templateId: TEMPLATE_ID })),
    ).toEqual({ error: "conflict" });
    expect(mocks.saveTemplate).not.toHaveBeenCalled();
  });

  it("changes nothing for an anonymous caller", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await saveTemplateAction({}, form(VALID_FORM))).toEqual({
      error: "unauthenticated",
    });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
  });

  it("answers generic when the database fails", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.saveTemplate.mockRejectedValue(new Error("boom"));
    expect(await saveTemplateAction({}, form(VALID_FORM))).toEqual({ error: "generic" });
    // The name only: the message could carry the school data of the SQL parameters.
    expect(logged).toHaveBeenCalledWith(
      { module: "templates", err: "Error" },
      "templates: could not save the template",
    );
    logged.mockRestore();
  });
});

describe("setDefaultTemplateAction", () => {
  it("sets the default for the signed-in teacher", async () => {
    expect(await setDefaultTemplateAction(TEMPLATE_ID)).toEqual({ ok: true });
    expect(mocks.setDefaultTemplate).toHaveBeenCalledWith(TX, {
      ownerId: USER.userId,
      templateId: TEMPLATE_ID,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("answers not found for another teacher's template or a malformed id", async () => {
    mocks.setDefaultTemplate.mockResolvedValueOnce({ ok: false, error: "notFound" });
    expect(await setDefaultTemplateAction(TEMPLATE_ID)).toEqual({
      ok: false,
      reason: "notFound",
    });
    expect(await setDefaultTemplateAction("x")).toEqual({
      ok: false,
      reason: "notFound",
    });
  });

  it("answers unauthenticated when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await setDefaultTemplateAction(TEMPLATE_ID)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(mocks.setDefaultTemplate).not.toHaveBeenCalled();
  });
});

describe("uploadLogoAction", () => {
  const file = (bytes: number, type = "image/png") =>
    new File([new Uint8Array(bytes)], "logo.png", { type });

  it("hands the bytes and the declared type to the service for the signed-in teacher", async () => {
    const state = await uploadLogoAction(
      {},
      form({ templateId: TEMPLATE_ID, logo: file(10) }),
    );
    expect(state.savedAt).toEqual(expect.any(Number));
    expect(state.error).toBeUndefined();
    const [store, db, request] = mocks.uploadLogo.mock.calls[0] as [
      unknown,
      unknown,
      { ownerId: string; templateId: string; bytes: Uint8Array; declaredType: string },
    ];
    expect(store).toEqual({ store: true });
    expect(db).toEqual({ db: true });
    expect(request).toEqual({
      ownerId: USER.userId,
      templateId: TEMPLATE_ID,
      bytes: new Uint8Array(10),
      declaredType: "image/png",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects a file of 1 MB + 1 byte before reading it", async () => {
    const state = await uploadLogoAction(
      {},
      form({ templateId: TEMPLATE_ID, logo: file(1024 * 1024 + 1) }),
    );
    expect(state).toEqual({ error: "tooLarge" });
    expect(mocks.uploadLogo).not.toHaveBeenCalled();
  });

  it("asks for a file when none was chosen", async () => {
    expect(await uploadLogoAction({}, form({ templateId: TEMPLATE_ID }))).toEqual({
      error: "empty",
    });
    expect(
      await uploadLogoAction({}, form({ templateId: TEMPLATE_ID, logo: file(0) })),
    ).toEqual({ error: "empty" });
  });

  it("passes the service's refusal on and answers not found for another teacher's template", async () => {
    mocks.uploadLogo.mockResolvedValueOnce({ ok: false, error: "unsupportedType" });
    expect(
      await uploadLogoAction({}, form({ templateId: TEMPLATE_ID, logo: file(10) })),
    ).toEqual({ error: "unsupportedType" });
    mocks.uploadLogo.mockResolvedValueOnce({ ok: false, error: "notFound" });
    expect(
      await uploadLogoAction({}, form({ templateId: TEMPLATE_ID, logo: file(10) })),
    ).toEqual({ error: "notFound" });
    expect(await uploadLogoAction({}, form({ templateId: "x", logo: file(10) }))).toEqual(
      {
        error: "notFound",
      },
    );
  });

  it("changes nothing for an anonymous caller", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(
      await uploadLogoAction({}, form({ templateId: TEMPLATE_ID, logo: file(10) })),
    ).toEqual({ error: "unauthenticated" });
    expect(mocks.uploadLogo).not.toHaveBeenCalled();
  });
});
