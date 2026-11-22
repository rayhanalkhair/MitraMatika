import "server-only";
// Job `alternative_method` (SOL-04): the same run as `solve_problem` (solve.ts), told every method
// label shown so far (the request's `excludeMethods` and every label stored since). An answer that
// repeats one of them is refused and repaired once by the gateway; a second repeat fails the run
// and the session keeps the methods it has.
import type { JobContext, JobHandler } from "@/lib/jobs/handler";
import { solveWithAnotherMethod, type SolverJobDeps } from "./solve";

export function alternativeMethod(deps: SolverJobDeps, ctx: JobContext) {
  return solveWithAnotherMethod(deps, ctx);
}

export function createAlternativeMethodHandler(deps: SolverJobDeps): JobHandler {
  return (ctx) => alternativeMethod(deps, ctx);
}
