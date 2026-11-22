"use server";

import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import type { LogoFormState } from "../schema/template";
import { MAX_LOGO_BYTES, uploadLogo } from "../service/logo";
import { isUuid } from "../service/templates";

// The logo (at most 1 MB) comes in with the form, so no presigned upload is needed; the body
// limit of Server Actions is raised just above it in next.config.ts. The service decides what
// the file is from its bytes.
export async function uploadLogoAction(
  _previous: LogoFormState,
  data: FormData,
): Promise<LogoFormState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { error: "unauthenticated" };

  const templateId = data.get("templateId");
  if (typeof templateId !== "string" || !isUuid(templateId)) return { error: "notFound" };
  const file = data.get("logo");
  if (!(file instanceof Blob) || file.size === 0) return { error: "empty" };
  // Checked before reading the bytes.
  if (file.size > MAX_LOGO_BYTES) return { error: "tooLarge" };

  try {
    const result = await uploadLogo(getObjectStore(), getDb(), {
      ownerId: authorization.data.userId,
      templateId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredType: file.type,
    });
    if (!result.ok) return { error: result.error };
    revalidatePath("/settings");
    return { savedAt: Date.now() };
  } catch (error) {
    logger.error(
      { module: "templates", err: error instanceof Error ? error.name : typeof error },
      "templates: could not store the logo",
    );
    return { error: "generic" };
  }
}
