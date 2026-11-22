import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it } from "vitest";
import {
  FIELD_ERROR_KEYS,
  fieldErrorKey,
  parseEmailForm,
  parseResetPasswordForm,
  parseSignInForm,
  parseSignUpForm,
  signUpFormValues,
} from "./auth-forms";
import { signUpFormSchema } from "./sign-up";
import { hasMessageKey } from "@/lib/i18n/translator";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const VALID_SIGN_UP = {
  name: "  Bu Rina ",
  email: " Rina@Example.TEST ",
  password: "rahasia123",
  confirmPassword: "rahasia123",
  schoolName: "",
  acceptPrivacy: "on",
};

describe("field error keys", () => {
  it("has a message for every key (the catalogs share their keys)", () => {
    for (const key of FIELD_ERROR_KEYS) {
      expect(hasMessageKey("auth.fieldErrors", key), key).toBe(true);
    }
  });
});

describe("parseSignUpForm", () => {
  it("returns the normalised sign-up, without the confirmation or the checkbox", () => {
    expect(parseSignUpForm(form(VALID_SIGN_UP))).toEqual({
      ok: true,
      data: {
        name: "Bu Rina",
        email: "rina@example.test",
        password: "rahasia123",
        schoolName: undefined,
      },
    });
  });

  it("reports one message key per field, for every field", () => {
    const result = parseSignUpForm(
      form({
        name: "R",
        email: "not-an-email",
        password: "abcdefgh",
        confirmPassword: "different",
        schoolName: "x".repeat(121),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        name: "nameLength",
        email: "emailInvalid",
        password: "passwordNeedsLetterAndDigit",
        confirmPassword: "passwordMismatch",
        schoolName: "schoolNameTooLong",
        acceptPrivacy: "privacyRequired",
      },
    });
  });

  it("treats missing fields as empty", () => {
    const result = parseSignUpForm(new FormData());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        name: "nameLength",
        email: "emailInvalid",
        password: "passwordTooShort",
        acceptPrivacy: "privacyRequired",
      });
    }
  });
});

describe("signUpFormValues", () => {
  it("reads the raw form values: strings, and the checkbox as a boolean", () => {
    expect(signUpFormValues(form(VALID_SIGN_UP))).toEqual({
      name: "  Bu Rina ",
      email: " Rina@Example.TEST ",
      password: "rahasia123",
      confirmPassword: "rahasia123",
      schoolName: "",
      acceptPrivacy: true,
    });
    expect(signUpFormValues(new FormData())).toEqual({
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      schoolName: "",
      acceptPrivacy: false,
    });
  });

  it("counts the privacy consent only for the value a checked box posts", () => {
    expect(signUpFormValues(form({ acceptPrivacy: "yes" })).acceptPrivacy).toBe(false);
  });
});

describe("sign-up: client and server return the same error keys", () => {
  // The browser: React Hook Form's resolver over the raw values (first error per field).
  async function clientKeys(fields: Record<string, string>) {
    const data = form(fields);
    const { errors } = await zodResolver(signUpFormSchema)(
      signUpFormValues(data),
      undefined,
      {
        fields: {},
        shouldUseNativeValidation: false,
      },
    );
    return Object.fromEntries(
      Object.entries(errors).map(([name, error]) => [
        name,
        fieldErrorKey(String(error.message)),
      ]),
    );
  }
  // The server: the Server Action's parser over the same FormData.
  function serverKeys(fields: Record<string, string>) {
    const result = parseSignUpForm(form(fields));
    return result.ok ? {} : result.error;
  }

  it.each([
    ["an empty form", {}],
    ["a bad email", { ...VALID_SIGN_UP, email: "bukan-email" }],
    [
      "a short password and a mismatch",
      { ...VALID_SIGN_UP, password: "abc1", confirmPassword: "abc2" },
    ],
    ["no privacy consent", { ...VALID_SIGN_UP, acceptPrivacy: "" }],
  ])("%s", async (_case, fields: Record<string, string>) => {
    const server = serverKeys(fields);
    expect(Object.keys(server).length).toBeGreaterThan(0);
    expect(await clientKeys(fields)).toEqual(server);
  });

  it("the empty form names every required field", () => {
    expect(serverKeys({})).toEqual({
      name: "nameLength",
      email: "emailInvalid",
      password: "passwordTooShort",
      acceptPrivacy: "privacyRequired",
    });
  });
});

describe("parseSignInForm", () => {
  it("normalises the address and keeps the password as typed", () => {
    expect(parseSignInForm(form({ email: " A@B.Test ", password: " x " }))).toEqual({
      ok: true,
      data: { email: "a@b.test", password: " x " },
    });
  });

  it("asks for an address and a password, without applying the sign-up policy", () => {
    expect(parseSignInForm(form({ email: "", password: "" }))).toEqual({
      ok: false,
      error: { email: "emailInvalid", password: "passwordRequired" },
    });
  });
});

describe("parseEmailForm", () => {
  it("normalises the address", () => {
    expect(parseEmailForm(form({ email: " X@Y.Test" }))).toEqual({
      ok: true,
      data: { email: "x@y.test" },
    });
  });

  it("rejects a malformed address", () => {
    expect(parseEmailForm(form({ email: "x@" }))).toEqual({
      ok: false,
      error: { email: "emailInvalid" },
    });
  });
});

describe("parseResetPasswordForm", () => {
  it("applies the password policy and the confirmation", () => {
    expect(
      parseResetPasswordForm(form({ password: "short1", confirmPassword: "short2" })),
    ).toEqual({
      ok: false,
      error: { password: "passwordTooShort", confirmPassword: "passwordMismatch" },
    });
  });

  it("returns the new password", () => {
    expect(
      parseResetPasswordForm(
        form({ password: "baru12345", confirmPassword: "baru12345" }),
      ),
    ).toEqual({ ok: true, data: { password: "baru12345" } });
  });
});
