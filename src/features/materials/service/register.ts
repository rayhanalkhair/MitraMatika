import { isFakeAiEnabled } from "@/lib/ai/e2e/control";
import { createRuntimeGateway } from "@/lib/ai/runtime";
import { getDb } from "@/lib/db/runtime";
import type { JobRegistry } from "@/lib/jobs/registry";
import { getObjectStore } from "@/lib/storage";
import { OCR_PAGES_JOB } from "../schema/ocr";
import { PROPOSE_STRUCTURE_JOB } from "../schema/structure";
import { INGEST_MATERIAL_JOB } from "../schema/upload";
import { createIngestMaterialHandler } from "./ingest";
import { createOcrPagesHandler } from "./ocr";
import { createProposeStructureHandler } from "./structure";

// The handlers are built per run so the database, the object store and the API keys are read when
// work starts, not when this module is imported (imports must work without any environment).
export function registerMaterialHandlers(registry: JobRegistry): void {
  registry.register(INGEST_MATERIAL_JOB, (ctx) =>
    createIngestMaterialHandler({
      db: getDb(),
      store: getObjectStore(),
    })(ctx),
  );
  registry.register(PROPOSE_STRUCTURE_JOB, (ctx) =>
    createProposeStructureHandler({
      db: getDb(),
      createGateway: createRuntimeGateway,
    })(ctx),
  );
  registry.register(OCR_PAGES_JOB, (ctx) =>
    createOcrPagesHandler({
      db: getDb(),
      store: getObjectStore(),
      createGateway: createRuntimeGateway,
      // The e2e fake AI spends nothing: its pages are not spaced a minute apart.
      paced: !isFakeAiEnabled(),
    })(ctx),
  );
}
