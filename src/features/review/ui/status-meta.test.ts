import { describe, expect, it } from "vitest";
import { checkTypeKey, displayStatus } from "./status-meta";

const v = (over: Record<string, unknown> = {}) =>
  ({
    status: "belum_dapat_diverifikasi",
    checked: false,
    checks: [],
    crossCheck: null,
    regenerated: false,
    regenerationFailed: false,
    ...over,
  }) as never;

describe("displayStatus", () => {
  it("is 'checking' only while the job is running and no run exists", () => {
    expect(displayStatus(v(), "running")).toBe("checking");
    expect(displayStatus(v(), "finished")).toBe("belum_dapat_diverifikasi");
    expect(displayStatus(v({ checked: true, status: "terverifikasi" }), "running")).toBe(
      "terverifikasi",
    );
  });

  it("is 'waiting' while the job is deferred and no run exists", () => {
    expect(displayStatus(v(), "deferred")).toBe("waiting");
    expect(displayStatus(v({ checked: true, status: "dicek_silang" }), "deferred")).toBe(
      "dicek_silang",
    );
  });
});

describe("checkTypeKey", () => {
  it("maps the whitelisted types and falls back to other", () => {
    expect(checkTypeKey("numeric_eval")).toBe("numeric");
    expect(checkTypeKey("expression_equivalent")).toBe("equivalent");
    expect(checkTypeKey("equation_solution")).toBe("equation");
    expect(checkTypeKey("choice_matches_answer")).toBe("choice");
    expect(checkTypeKey("other")).toBe("other");
  });
});
