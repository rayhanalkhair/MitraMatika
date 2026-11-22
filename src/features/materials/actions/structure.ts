"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";
import {
  structureFormSchema,
  type ConfirmStructureError,
  type RequestStructureError,
} from "../schema/structure";
import { confirmStructure, requestStructureProposal } from "../service/structure";

export type RequestStructureState =
  | { ok: true; jobId: string }
  | { ok: false; error: RequestStructureError | "unauthenticated" | "generic" };
export type ConfirmStructureState =
  | { ok: true }
  | {
      ok: false;
      error: ConfirmStructureError | "invalid" | "unauthenticated" | "generic";
    };

const requestSchema = z.object({ materialId: z.uuid() });
// The form's values as typed, parsed with the schema the browser validates with.
const confirmSchema = z.object({ materialId: z.uuid(), values: structureFormSchema });

function crashed(error: unknown, message: string) {
  logger.error(
    { module: "materials", err: error instanceof Error ? error.name : typeof error },
    message,
  );
  return { ok: false as const, error: "generic" as const };
}

/**
 * Asks the AI for a structure proposal of one of the signed-in teacher's materials (the
 * `propose_structure` job) and starts the runner after the response. The server writes the jobs
 * table, so this runs on the service connection with the owner from the session (R9). The page
 * that hosts it (/materials/[id]) exports maxDuration = 300 for the run.
 */
export async function requestStructureAction(input: {
  materialId: string;
}): Promise<RequestStructureState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "generic" };
  try {
    const result = await requestStructureProposal(getDb(), {
      ownerId: authorization.data.userId,
      materialId: parsed.data.materialId,
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    try {
      scheduleRun();
    } catch {
      // The status poll (or the daily run) runs the job.
    }
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    return crashed(error, "materials: could not ask for a structure proposal");
  }
}

/**
 * Saves the teacher's structure: title, grade, academic year and chapters, and the confirmation
 * time (a server-only column, so the service connection with the owner from the session, R9).
 * `values` are the form's strings as typed; they are parsed here with `structureFormSchema`.
 */
export async function confirmStructureAction(
  input: unknown,
): Promise<ConfirmStructureState> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, error: "unauthenticated" };
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const result = await confirmStructure(getDb(), {
      ownerId: authorization.data.userId,
      input: { materialId: parsed.data.materialId, ...parsed.data.values },
      now: new Date(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath("/materials");
    revalidatePath(`/materials/${parsed.data.materialId}`);
    return { ok: true };
  } catch (error) {
    return crashed(error, "materials: could not save a structure");
  }
}
