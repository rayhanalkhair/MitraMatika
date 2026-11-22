import { describe, expect, it } from "vitest";
import type { ClaimResult } from "./claims";
import {
  CROSS_CHECK_DISAGREES,
  crossCheckVerdict,
  decideStatus,
  VERIFIER_VERSION,
} from "./decide-status";

const claim = { type: "numeric_eval", expression: "1+1", expected: "2" } as const;
const result = (status: ClaimResult["status"], detail = "d"): ClaimResult => ({
  claim,
  status,
  detail,
});

describe("decideStatus", () => {
  it.each([
    ["all pass, solver agrees", [result("pass")], "agree", "terverifikasi"],
    ["all pass, solver unknown", [result("pass")], "unknown", "terverifikasi"],
    [
      "pass and unsupported",
      [result("pass"), result("unsupported")],
      "agree",
      "terverifikasi",
    ],
    ["none pass, solver agrees", [result("unsupported")], "agree", "dicek_silang"],
    ["no claims, solver agrees", [], "agree", "dicek_silang"],
    [
      "none pass, solver unknown",
      [result("unsupported")],
      "unknown",
      "belum_dapat_diverifikasi",
    ],
    ["no claims, solver unknown", [], "unknown", "belum_dapat_diverifikasi"],
    ["a claim fails", [result("fail", "salah")], "agree", "ketidaksesuaian"],
    ["claim fails and solver unknown", [result("fail")], "unknown", "ketidaksesuaian"],
    ["all pass, solver disagrees", [result("pass")], "disagree", "ketidaksesuaian"],
    [
      "none pass, solver disagrees",
      [result("unsupported")],
      "disagree",
      "ketidaksesuaian",
    ],
  ] as const)("%s -> %s", (_name, claims, verdict, expected) => {
    expect(decideStatus([...claims], verdict).status).toBe(expected);
  });

  it("returns the failing details as reasons", () => {
    const decision = decideStatus(
      [result("fail", "a salah"), result("fail", "b salah")],
      "agree",
    );
    expect(decision.reasons).toEqual(["a salah", "b salah"]);
  });

  it("explains a solver disagreement", () => {
    expect(decideStatus([result("pass")], "disagree").reasons).toEqual([
      CROSS_CHECK_DISAGREES,
    ]);
  });

  it("has no reasons for a clean pass", () => {
    expect(decideStatus([result("pass")], "agree").reasons).toEqual([]);
  });
});

describe("crossCheckVerdict", () => {
  const base = { questionLabel: "B", questionMachine: "13" };

  it("agrees when the solver chose the same option", () => {
    expect(crossCheckVerdict({ ...base, solverLabel: "B", solverMachine: "13" })).toBe(
      "agree",
    );
  });

  it("agrees on the same option even when the machine answers differ only in notation", () => {
    expect(
      crossCheckVerdict({
        solverLabel: "B",
        solverMachine: "x=4.0",
        questionLabel: "B",
        questionMachine: "x=4",
      }),
    ).toBe("agree");
  });

  it("agrees when the labels differ but the answers are the same value", () => {
    expect(crossCheckVerdict({ ...base, solverLabel: "C", solverMachine: "13,0" })).toBe(
      "agree",
    );
  });

  it("disagrees when the solver chose another option with another value", () => {
    expect(crossCheckVerdict({ ...base, solverLabel: "A", solverMachine: "12" })).toBe(
      "disagree",
    );
  });
});

describe("VERIFIER_VERSION", () => {
  it("is a stable string recorded with every run", () => {
    expect(VERIFIER_VERSION).toBe("p1-12.1");
  });
});
