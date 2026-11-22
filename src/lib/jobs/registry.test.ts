import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry";

const handler = () => Promise.resolve({ kind: "done" as const });

describe("createRegistry", () => {
  it("returns a registered handler by type", () => {
    const registry = createRegistry();
    registry.register("a", handler);
    expect(registry.get("a")).toBe(handler);
  });

  it("returns undefined for an unknown type", () => {
    expect(createRegistry().get("nope")).toBeUndefined();
  });

  it("refuses to register the same type twice", () => {
    const registry = createRegistry();
    registry.register("a", handler);
    expect(() => {
      registry.register("a", handler);
    }).toThrow(/already registered/);
  });
});
