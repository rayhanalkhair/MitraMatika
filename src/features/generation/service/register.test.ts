import { describe, expect, it } from "vitest";
import { defaultRegistry } from "@/lib/jobs/default";
import { createRegistry } from "@/lib/jobs/registry";
import { registerGenerationHandlers } from "./register";

describe("registerGenerationHandlers", () => {
  it("registers the generate_batch and regenerate_question handlers once", () => {
    const registry = createRegistry();
    registerGenerationHandlers(registry);
    expect(registry.get("generate_batch")).toBeTypeOf("function");
    expect(registry.get("regenerate_question")).toBeTypeOf("function");
    expect(() => {
      registerGenerationHandlers(registry);
    }).toThrow(/already registered/);
  });

  it("is wired into the default registry the runner uses", () => {
    expect(defaultRegistry.get("generate_batch")).toBeTypeOf("function");
    expect(defaultRegistry.get("regenerate_question")).toBeTypeOf("function");
  });
});
