import { getDb } from "@/lib/db/runtime";
import type { JobRegistry } from "@/lib/jobs/registry";
import { getObjectStore } from "@/lib/storage";
import { createRenderExportHandler, EXPORT_JOB_TYPE } from "./export-job";

// The handler is built per run so the database and the object store are read when work starts,
// not when this module is imported (imports must work without any environment configured).
export function registerExportHandlers(registry: JobRegistry): void {
  registry.register(EXPORT_JOB_TYPE, (ctx) =>
    createRenderExportHandler({
      db: getDb(),
      store: getObjectStore(),
    })(ctx),
  );
}
