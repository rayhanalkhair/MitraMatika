import { isFakeAiEnabled } from "@/lib/ai/e2e/control";
import { createRuntimeGateway } from "@/lib/ai/runtime";
import { getDb } from "@/lib/db/runtime";
import type { JobRegistry } from "@/lib/jobs/registry";
import { getObjectStore } from "@/lib/storage";
import {
  ALTERNATIVE_METHOD_JOB,
  EXTRACT_PROBLEM_JOB,
  SOLVE_PROBLEM_JOB,
} from "../schema/solver";
import { createAlternativeMethodHandler } from "./alternative";
import { createExtractProblemHandler } from "./extract";
import type { SolverDb } from "./quota";
import { createSolveProblemHandler } from "./solve";

// The handlers are built per run so the database, the object store and the API keys are read when
// work starts, not when this module is imported (imports must work without any environment).
export function registerSolverHandlers(registry: JobRegistry): void {
  const db = () => getDb() as unknown as SolverDb;
  registry.register(EXTRACT_PROBLEM_JOB, (ctx) =>
    createExtractProblemHandler({
      db: db(),
      store: getObjectStore(),
      createGateway: createRuntimeGateway,
      // The e2e fake AI spends nothing: its photo readings are not spaced a minute apart.
      paced: !isFakeAiEnabled(),
    })(ctx),
  );
  registry.register(SOLVE_PROBLEM_JOB, (ctx) =>
    createSolveProblemHandler({ db: db(), createGateway: createRuntimeGateway })(ctx),
  );
  registry.register(ALTERNATIVE_METHOD_JOB, (ctx) =>
    createAlternativeMethodHandler({ db: db(), createGateway: createRuntimeGateway })(
      ctx,
    ),
  );
}
