import { describe, expect, it } from "vitest";
import { createRegistry } from "@/lib/jobs/registry";
import { EXPORT_JOB_TYPE } from "./export-job";
import { registerExportHandlers } from "./register";

describe("registerExportHandlers", () => {
  it("registers the render_export handler without reading the environment", () => {
    const registry = createRegistry();
    registerExportHandlers(registry);
    expect(EXPORT_JOB_TYPE).toBe("render_export");
    expect(registry.get("render_export")).toBeTypeOf("function");
  });
});
