"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { isUuid, setDefaultTemplate, type TemplateDb } from "../service/templates";

export type SetDefaultTemplateResult =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "notFound" | "conflict" | "generic" };

/** Makes one of the signed-in teacher's templates the default. */
export async function setDefaultTemplateAction(
  templateId: string,
): Promise<SetDefaultTemplateResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "unauthenticated" };
  if (typeof templateId !== "string" || !isUuid(templateId)) {
    return { ok: false, reason: "notFound" };
  }
  const ownerId = authorization.data.userId;
  try {
    const result = await runAsUser(getDb(), ownerId, (tx) =>
      setDefaultTemplate(tx as unknown as TemplateDb, { ownerId, templateId }),
    );
    if (!result.ok) return { ok: false, reason: result.error };
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    logger.error(
      { module: "templates", err: error instanceof Error ? error.name : typeof error },
      "templates: could not set the default template",
    );
    return { ok: false, reason: "generic" };
  }
}
