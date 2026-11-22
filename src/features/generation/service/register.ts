import { createRuntimeGateway } from "@/lib/ai/runtime";
import { getDb } from "@/lib/db/runtime";
import type { JobRegistry } from "@/lib/jobs/registry";
import { REGENERATE_JOB_TYPE } from "../schema/regenerate-input";
import { createGenerateBatchHandler } from "./generate-batch";
import { createRegenerateQuestionHandler } from "./regenerate";

// The handler is built per run so the database and API keys are read when work starts, not when
// this module is imported (imports must work without any environment configured).
export function registerGenerationHandlers(registry: JobRegistry): void {
  registry.register("generate_batch", (ctx) =>
    createGenerateBatchHandler({
      db: getDb(),
      createGateway: createRuntimeGateway,
    })(ctx),
  );
  registry.register(REGENERATE_JOB_TYPE, (ctx) =>
    createRegenerateQuestionHandler({
      db: getDb(),
      createGateway: createRuntimeGateway,
    })(ctx),
  );
}
