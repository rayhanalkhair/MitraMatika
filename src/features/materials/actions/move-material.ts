"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import type { MoveMaterialError } from "../schema/library";
import { moveMaterial } from "../service/library";
import type { MaterialDb } from "../service/upload";

export type MoveMaterialState =
  { ok: true } | { ok: false; error: MoveMaterialError | "unauthenticated" | "generic" };

const schema = z.object({ materialId: z.uuid(), folderId: z.uuid().nullable() });

/** Moves one of the signed-in teacher's materials into a folder, or to the top level. */
export async function moveMaterialAction(input: {
  materialId: string;
  folderId: string | null;
}): Promise<MoveMaterialState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  const ownerId = authorization.data.userId;
  try {
    const result = await runAsUser(getDb(), ownerId, (tx) =>
      moveMaterial(tx as unknown as MaterialDb, { ownerId, ...parsed.data }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/materials");
    revalidatePath(`/materials/${parsed.data.materialId}`);
    return { ok: true };
  } catch (error) {
    logger.error(
      { module: "materials", err: error instanceof Error ? error.name : typeof error },
      "materials: could not move a material",
    );
    return { ok: false, error: "generic" };
  }
}
