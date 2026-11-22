"use server";

import { z } from "zod";
import { authorizeAction } from "@/features/auth";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { logger } from "@/lib/logger";
import { requestExport } from "../service/request-export";
import type { StartExportResult } from "./result";

const inputSchema = z.object({ assessmentId: z.uuid() });

/**
 * The export panel's button: queues `render_export` for the signed-in teacher's approved
 * assessment and starts the runner after the response (this page exports maxDuration = 300).
 */
export async function startExportAction(raw: unknown): Promise<StartExportResult> {
  const authorization = await authorizeAction();
  if (!authorization.ok) return { ok: false, reason: "signedOut" };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "notFound" };
  // The owner is the signed-in teacher, never anything the client sent. The service connection
  // writes the job (the `authenticated` role may not insert jobs); every statement names owner_id.
  const ownerId = authorization.data.userId;
  try {
    const result = await requestExport(getDb(), {
      ownerId,
      assessmentId: parsed.data.assessmentId,
      now: new Date(),
    });
    if (!result.ok) {
      const failure = result.error;
      if (failure.reason === "pending") {
        return { ok: false, reason: "pending", jobId: failure.jobId };
      }
      if (failure.reason === "hourlyLimit") {
        return {
          ok: false,
          reason: "hourlyLimit",
          limit: failure.limit,
          resetsAt: failure.resetsAt.toISOString(),
        };
      }
      return { ok: false, reason: failure.reason };
    }
    try {
      scheduleRun();
    } catch (error) {
      // The job is queued; the next poll, kick or daily run picks it up even if this trigger failed.
      logger.error(
        { module: "export", err: safeErrorSummary(error) },
        "export: could not schedule the runner",
      );
    }
    return { ok: true, jobId: result.data.jobId };
  } catch (error) {
    logger.error(
      { module: "export", err: safeErrorSummary(error) },
      "export: could not start an export",
    );
    return { ok: false, reason: "generic" };
  }
}
