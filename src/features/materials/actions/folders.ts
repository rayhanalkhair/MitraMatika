"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import type { FolderError } from "../schema/library";
import { createFolder, moveFolder, renameFolder } from "../service/library";
import type { MaterialDb } from "../service/upload";

export type FolderActionState =
  | { ok: true; id?: string }
  | { ok: false; error: FolderError | "unauthenticated" | "generic" };

const nameSchema = z.string().max(1000);
const createSchema = z.object({
  name: nameSchema,
  parentId: z.uuid().nullable().optional(),
});
const renameSchema = z.object({ folderId: z.uuid(), name: nameSchema });
const moveSchema = z.object({ folderId: z.uuid(), parentId: z.uuid().nullable() });

/** Runs one folder write as the signed-in teacher (runAsUser: RLS and the DB's nesting rule). */
async function asTeacher<T>(
  userId: string,
  write: (db: MaterialDb) => Promise<T>,
): Promise<T> {
  return runAsUser(getDb(), userId, (tx) => write(tx as unknown as MaterialDb));
}

function crashed(error: unknown): FolderActionState {
  logger.error(
    { module: "materials", err: error instanceof Error ? error.name : typeof error },
    "materials: a folder change failed",
  );
  return { ok: false, error: "generic" };
}

/** A new folder at the top level or inside one of the teacher's top-level folders. */
export async function createFolderAction(input: {
  name: string;
  parentId?: string | null;
}): Promise<FolderActionState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  const ownerId = authorization.data.userId;
  try {
    const result = await asTeacher(ownerId, (db) =>
      createFolder(db, {
        ownerId,
        name: parsed.data.name,
        parentId: parsed.data.parentId ?? null,
      }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/materials");
    return { ok: true, id: result.data.id };
  } catch (error) {
    return crashed(error);
  }
}

/** Renames one of the signed-in teacher's folders. */
export async function renameFolderAction(input: {
  folderId: string;
  name: string;
}): Promise<FolderActionState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  const ownerId = authorization.data.userId;
  try {
    const result = await asTeacher(ownerId, (db) =>
      renameFolder(db, { ownerId, ...parsed.data }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/materials");
    return { ok: true };
  } catch (error) {
    return crashed(error);
  }
}

/** Moves a folder to the top level (`parentId` null) or into a top-level folder. */
export async function moveFolderAction(input: {
  folderId: string;
  parentId: string | null;
}): Promise<FolderActionState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  const ownerId = authorization.data.userId;
  try {
    const result = await asTeacher(ownerId, (db) =>
      moveFolder(db, { ownerId, ...parsed.data }),
    );
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/materials");
    return { ok: true };
  } catch (error) {
    return crashed(error);
  }
}
