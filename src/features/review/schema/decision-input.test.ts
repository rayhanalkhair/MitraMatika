import { describe, expect, it } from "vitest";
import { parseDecisionInput } from "./decision-input";

const base = {
  questionId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  rowVersion: 1,
  action: "approve",
};

describe("parseDecisionInput", () => {
  it("accepts a valid input, with and without a note", () => {
    expect(parseDecisionInput(base)).toEqual({ ok: true, value: base });
    const withNote = { ...base, overrideNote: "  catatan panjang  " };
    expect(parseDecisionInput(withNote)).toEqual({ ok: true, value: withNote });
  });
  it.each([
    ["a bad question uuid", { ...base, questionId: "x" }],
    ["a bad version uuid", { ...base, versionId: "x" }],
    ["rowVersion 0", { ...base, rowVersion: 0 }],
    ["rowVersion 1.5", { ...base, rowVersion: 1.5 }],
    ["an unknown action", { ...base, action: "delete" }],
    ["a non-string note", { ...base, overrideNote: 5 }],
    ["an oversized note", { ...base, overrideNote: "a".repeat(2001) }],
    ["null", null],
  ])("rejects %s", (_name, raw) => {
    expect(parseDecisionInput(raw)).toEqual({ ok: false });
  });
});
