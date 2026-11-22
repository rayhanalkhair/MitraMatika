import { describe, expect, it } from "vitest";
import { signUpFormSchema } from "./sign-up";

const valid = {
  name: "Bu Guru",
  email: "guru@example.test",
  password: "rahasia123",
  confirmPassword: "rahasia123",
  schoolName: "SMP Negeri 1",
  acceptPrivacy: true,
};

const issues = (input: unknown) => {
  const result = signUpFormSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
};

describe("signUpFormSchema", () => {
  it("accepts a valid form and normalises it", () => {
    expect(
      signUpFormSchema.parse({
        ...valid,
        name: "  Bu Guru  ",
        email: "  Guru@Example.TEST ",
        schoolName: "  SMP Negeri 1 ",
      }),
    ).toEqual({
      name: "Bu Guru",
      email: "guru@example.test",
      password: "rahasia123",
      schoolName: "SMP Negeri 1",
    });
  });

  it("treats a blank school name as no school", () => {
    expect(signUpFormSchema.parse({ ...valid, schoolName: "" }).schoolName).toBe(
      undefined,
    );
    expect(signUpFormSchema.parse({ ...valid, schoolName: "   " }).schoolName).toBe(
      undefined,
    );
  });

  it("requires a name of 2 to 80 characters after trimming", () => {
    expect(issues({ ...valid, name: " a " })).toEqual([["name", "nameLength"]]);
    expect(issues({ ...valid, name: "x".repeat(81) })).toEqual([["name", "nameLength"]]);
    expect(issues({ ...valid, name: "ab" })).toEqual([]);
    expect(issues({ ...valid, name: "x".repeat(80) })).toEqual([]);
  });

  it("rejects an invalid email", () => {
    expect(issues({ ...valid, email: "not-an-email" })).toEqual([
      ["email", "emailInvalid"],
    ]);
  });

  it("applies the password policy", () => {
    const weak = { ...valid, password: "abcdefgh", confirmPassword: "abcdefgh" };
    expect(issues(weak)).toEqual([["password", "passwordNeedsLetterAndDigit"]]);
    const short = { ...valid, password: "abc1", confirmPassword: "abc1" };
    expect(issues(short)).toEqual([["password", "passwordTooShort"]]);
  });

  it("requires the confirmation to match", () => {
    expect(issues({ ...valid, confirmPassword: "rahasia124" })).toEqual([
      ["confirmPassword", "passwordMismatch"],
    ]);
  });

  it("reports a mismatched confirmation together with the other field errors", () => {
    expect(
      issues({
        ...valid,
        name: "R",
        email: "x",
        password: "a",
        confirmPassword: "b",
        acceptPrivacy: false,
      }),
    ).toEqual([
      ["name", "nameLength"],
      ["email", "emailInvalid"],
      ["password", "passwordTooShort"],
      ["acceptPrivacy", "privacyRequired"],
      ["confirmPassword", "passwordMismatch"],
    ]);
  });

  it("reports a mismatch even next to a field of the wrong type", () => {
    // A missing consent is a type issue, which makes zod skip refinements without `when`.
    expect(
      issues({ ...valid, confirmPassword: "lain", acceptPrivacy: undefined }),
    ).toEqual([
      ["acceptPrivacy", "privacyRequired"],
      ["confirmPassword", "passwordMismatch"],
    ]);
  });

  it("refuses a payload that is not an object", () => {
    expect(issues(null)).toHaveLength(1);
  });

  it("limits the school name to 120 characters", () => {
    expect(issues({ ...valid, schoolName: "s".repeat(121) })).toEqual([
      ["schoolName", "schoolNameTooLong"],
    ]);
    expect(issues({ ...valid, schoolName: "s".repeat(120) })).toEqual([]);
  });

  it("requires accepting the privacy notice", () => {
    expect(issues({ ...valid, acceptPrivacy: false })).toEqual([
      ["acceptPrivacy", "privacyRequired"],
    ]);
    expect(issues({ ...valid, acceptPrivacy: undefined })).toEqual([
      ["acceptPrivacy", "privacyRequired"],
    ]);
  });

  it("refuses an address longer than 254 characters", () => {
    const at254 = `${"a".repeat(64)}@${"b".repeat(184)}.test`;
    expect(at254.length).toBe(254);
    expect(issues({ ...valid, email: at254 })).toEqual([]);
    expect(issues({ ...valid, email: `a${at254}` })).toEqual([["email", "emailInvalid"]]);
  });
});
