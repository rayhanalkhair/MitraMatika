"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { parseTemplateForm, type TemplateFormState } from "../schema/template";
import { isUuid, saveTemplate, type TemplateDb } from "../service/templates";

// Settings > Templat dokumen: create or update a template. The owner is the signed-in teacher;
// the template id and row version come from the form and are checked under RLS.
export async function saveTemplateAction(
  _previous: TemplateFormState,
  data: FormData,
): Promise<TemplateFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };
  const ownerId = authorization.data.userId;

  const rawId = data.get("templateId");
  const templateId = typeof rawId === "string" && rawId !== "" ? rawId : undefined;
  if (templateId !== undefined && !isUuid(templateId)) return { error: "notFound" };
  let expectedRowVersion: number | undefined;
  if (templateId !== undefined) {
    expectedRowVersion = Number(data.get("expectedRowVersion"));
    if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
      return { error: "conflict" };
    }
  }

  const parsed = parseTemplateForm(data);
  if (!parsed.ok) return { fieldErrors: parsed.error };

  try {
    const saved = await runAsUser(getDb(), ownerId, (tx) =>
      saveTemplate(tx as unknown as TemplateDb, {
        ownerId,
        templateId,
        expectedRowVersion,
        input: parsed.data,
      }),
    );
    if (!saved.ok) return { error: saved.error };
    revalidatePath("/settings");
    return { savedAt: Date.now(), templateId: saved.data.id };
  } catch (error) {
    // The error message may carry the SQL parameters (school data): log the name only.
    logger.error(
      { module: "templates", err: error instanceof Error ? error.name : typeof error },
      "templates: could not save the template",
    );
    return { error: "generic" };
  }
}
