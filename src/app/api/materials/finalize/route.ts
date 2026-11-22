import { revalidatePath } from "next/cache";
import { authorizeAction } from "@/features/auth";
import { finalizeUpload, handleFinalizeRequest } from "@/features/materials";
import { getDb } from "@/lib/db/runtime";
import { scheduleRun } from "@/lib/jobs/trigger";
import { getObjectStore } from "@/lib/storage";

// Step 2 of an upload (Ruling R16): finalise parses the file in a worker thread, and only route
// handlers carry the emitted worker files (next.config.ts INGEST_FILES). A new material's
// ingestion starts in this request's after(), bound to this route's maxDuration like the daily run.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleFinalizeRequest(request, {
    authorize: authorizeAction,
    db: getDb(),
    store: getObjectStore,
    finalize: finalizeUpload,
    afterFinalize: () => {
      revalidatePath("/materials");
      scheduleRun();
    },
  });
}
