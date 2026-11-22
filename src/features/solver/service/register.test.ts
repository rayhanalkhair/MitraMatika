import { describe, expect, it } from "vitest";
import { createRegistry } from "@/lib/jobs/registry";
import { SOLVER_JOB_TYPES } from "../schema/solver";
import { registerSolverHandlers } from "./register";

describe("registerSolverHandlers", () => {
  it("registers a handler for each solver job", () => {
    const registry = createRegistry();
    registerSolverHandlers(registry);
    for (const type of SOLVER_JOB_TYPES) {
      expect(typeof registry.get(type), type).toBe("function");
    }
  });
});
