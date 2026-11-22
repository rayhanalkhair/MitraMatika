import { describe, expect, it } from "vitest";
import { checkPassword, PASSWORD_MAX, PASSWORD_MIN } from "./password-policy";

describe("password policy", () => {
  it("is 8 to 128 characters", () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MAX).toBe(128);
  });

  it.each([
    ["7 chars", "abcde12", { ok: false, error: "tooShort" }],
    ["129 chars", `a1${"x".repeat(127)}`, { ok: false, error: "tooLong" }],
    ["letters only", "abcdefghij", { ok: false, error: "needsLetterAndDigit" }],
    ["digits only", "1234567890", { ok: false, error: "needsLetterAndDigit" }],
    [
      "symbols and digits only",
      "12345678!@#",
      { ok: false, error: "needsLetterAndDigit" },
    ],
    ["valid, 8 chars", "abcdefg1", { ok: true }],
    ["valid, 128 chars", `a1${"x".repeat(126)}`, { ok: true }],
    ["valid, non-latin letter", "kataSandi9", { ok: true }],
    ["valid, Indonesian with spaces", "kucing hitam 7", { ok: true }],
  ])("%s", (_label, password, expected) => {
    expect(checkPassword(password)).toMatchObject(expected);
  });

  it("counts characters, not UTF-16 code units", () => {
    // 7 emoji are 14 code units but 7 characters.
    expect(checkPassword("a1😀😀😀😀😀")).toMatchObject({ ok: false, error: "tooShort" });
  });
});
