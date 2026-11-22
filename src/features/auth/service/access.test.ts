import { describe, expect, it } from "vitest";
import { resolveAccess } from "./access";
import type { SessionUser } from "./auth-port";

describe("resolveAccess", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats %s as anonymous", (_label, user) => {
    expect(resolveAccess(user as SessionUser | null)).toEqual({
      status: "anonymous",
    });
  });

  it("treats a session user without a usable id as anonymous", () => {
    expect(resolveAccess({ id: "  ", email: "guru@example.com" })).toEqual({
      status: "anonymous",
    });
    expect(
      resolveAccess({ id: 42, email: "guru@example.com" } as unknown as SessionUser),
    ).toEqual({ status: "anonymous" });
  });

  it("treats a session user without a usable email as anonymous", () => {
    expect(resolveAccess({ id: "user-1", email: "" })).toEqual({
      status: "anonymous",
    });
    expect(resolveAccess({ id: "user-1", email: 7 } as unknown as SessionUser)).toEqual({
      status: "anonymous",
    });
  });

  it("returns allowed for any user with id and email", () => {
    expect(resolveAccess({ id: "user-2", email: " Stranger@Example.com " })).toEqual({
      status: "allowed",
      userId: "user-2",
      email: "stranger@example.com",
      displayName: null,
    });
  });

  it("lower-cases the email", () => {
    expect(resolveAccess({ id: "user-1", email: "Guru@Example.com" })).toEqual({
      status: "allowed",
      userId: "user-1",
      email: "guru@example.com",
      displayName: null,
    });
  });

  it("takes the display name from the user's name, trimmed", () => {
    expect(
      resolveAccess({ id: "u", email: "guru@example.com", name: " Bu Guru " }),
    ).toMatchObject({ status: "allowed", displayName: "Bu Guru" });
  });

  it("ignores a blank or non-string name", () => {
    expect(
      resolveAccess({ id: "u", email: "guru@example.com", name: "  " }),
    ).toMatchObject({ status: "allowed", displayName: null });
    expect(
      resolveAccess({
        id: "u",
        email: "guru@example.com",
        name: 5,
      } as unknown as SessionUser),
    ).toMatchObject({ status: "allowed", displayName: null });
  });
});
