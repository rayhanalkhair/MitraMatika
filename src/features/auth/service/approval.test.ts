import { afterEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn } }));

import {
  isAdminEmail,
  isApprovedEmail,
  MAX_LIST_ENTRIES,
  parseEmailList,
  resetApprovalWarnings,
} from "./approval";

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockReset();
  resetApprovalWarnings();
});

describe("parseEmailList", () => {
  it("splits on commas and whitespace, trims, lower-cases and dedupes", () => {
    expect(parseEmailList(" A@X.com, ,b@y.id,\nc@z.org a@x.com")).toEqual(
      new Set(["a@x.com", "b@y.id", "c@z.org"]),
    );
  });

  it("ignores entries without exactly one @ and text on both sides", () => {
    expect(parseEmailList("nobody, @x.com, a@, a@@b")).toEqual(new Set());
  });

  it("is empty for undefined, empty and whitespace-only input", () => {
    expect(parseEmailList(undefined)).toEqual(new Set());
    expect(parseEmailList("")).toEqual(new Set());
    expect(parseEmailList("   \n ")).toEqual(new Set());
  });

  it("keeps at most 1000 entries", () => {
    const raw = Array.from({ length: 1500 }, (_, i) => `u${String(i)}@x.com`).join(",");
    expect(MAX_LIST_ENTRIES).toBe(1000);
    const parsed = parseEmailList(raw);
    expect(parsed.size).toBe(1000);
    expect(parsed.has("u0@x.com")).toBe(true);
    expect(parsed.has("u1000@x.com")).toBe(false);
  });
});

describe("isApprovedEmail", () => {
  it("approves a listed address, ignoring case", () => {
    expect(isApprovedEmail("A@x.com", { ALLOWED_EMAILS: "a@x.com" })).toBe(true);
    expect(isApprovedEmail(" a@x.com ", { ALLOWED_EMAILS: "A@X.COM" })).toBe(true);
  });

  it("does not approve an unlisted address", () => {
    expect(isApprovedEmail("b@x.com", { ALLOWED_EMAILS: "a@x.com" })).toBe(false);
  });

  it("always approves the admin, ignoring case", () => {
    expect(isApprovedEmail("Boss@X.com", { ADMIN_EMAIL: "boss@x.com" })).toBe(true);
    expect(isApprovedEmail("boss@x.com", { ADMIN_EMAIL: " BOSS@x.com " })).toBe(true);
  });

  it("approves nobody when the admin is unset and the list is empty", () => {
    expect(isApprovedEmail("a@x.com", {})).toBe(false);
    expect(isApprovedEmail("a@x.com", { ALLOWED_EMAILS: "", ADMIN_EMAIL: "" })).toBe(
      false,
    );
    expect(isApprovedEmail("", { ALLOWED_EMAILS: "", ADMIN_EMAIL: "" })).toBe(false);
  });

  it("does not fold dots or +tags", () => {
    expect(isApprovedEmail("a+1@x.com", { ALLOWED_EMAILS: "a@x.com" })).toBe(false);
    expect(isApprovedEmail("a.b@x.com", { ALLOWED_EMAILS: "ab@x.com" })).toBe(false);
  });

  it("is not fooled by an admin value without an @", () => {
    expect(isApprovedEmail("admin", { ADMIN_EMAIL: "admin" })).toBe(false);
  });

  it("re-reads the environment on every call", () => {
    vi.stubEnv("ALLOWED_EMAILS", "a@x.com");
    expect(isApprovedEmail("a@x.com")).toBe(true);
    vi.stubEnv("ALLOWED_EMAILS", "b@x.com");
    expect(isApprovedEmail("a@x.com")).toBe(false);
    vi.stubEnv("ALLOWED_EMAILS", "");
    vi.stubEnv("ADMIN_EMAIL", "a@x.com");
    expect(isApprovedEmail("a@x.com")).toBe(true);
    expect(isAdminEmail("a@x.com")).toBe(true);
    vi.stubEnv("ADMIN_EMAIL", "");
    expect(isAdminEmail("a@x.com")).toBe(false);
  });
});

describe("isAdminEmail", () => {
  it("matches only the admin address", () => {
    expect(isAdminEmail("Boss@x.com", { ADMIN_EMAIL: "boss@x.com" })).toBe(true);
    expect(
      isAdminEmail("a@x.com", { ADMIN_EMAIL: "boss@x.com", ALLOWED_EMAILS: "a@x.com" }),
    ).toBe(false);
    expect(isAdminEmail("a@x.com", {})).toBe(false);
  });
});

describe("warning about a misconfigured environment", () => {
  it("warns once about malformed ALLOWED_EMAILS entries, without any address", () => {
    vi.stubEnv("ALLOWED_EMAILS", "good@x.com; nobody, Name <a@x.com>");
    expect(isApprovedEmail("good@x.com")).toBe(false);
    expect(isApprovedEmail("other@x.com")).toBe(false);
    expect(isApprovedEmail("other@x.com")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("ALLOWED_EMAILS");
    expect(logged).not.toMatch(/@|good|nobody/);
  });

  it("warns once when ALLOWED_EMAILS has more than 1000 entries", () => {
    const raw = Array.from({ length: 1001 }, (_, i) => `u${String(i)}@x.com`).join(",");
    vi.stubEnv("ALLOWED_EMAILS", raw);
    isApprovedEmail("u0@x.com");
    isApprovedEmail("u0@x.com");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("@");
  });

  it("warns about a malformed ADMIN_EMAIL, such as a list of two addresses", () => {
    vi.stubEnv("ADMIN_EMAIL", "a@x.com,b@x.com");
    isApprovedEmail("a@x.com");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("ADMIN_EMAIL");
    expect(logged).not.toContain("@");
  });

  it("stays silent for clean, empty and unset values", () => {
    vi.stubEnv("ALLOWED_EMAILS", " a@x.com, b@x.com ");
    vi.stubEnv("ADMIN_EMAIL", "boss@x.com");
    isApprovedEmail("a@x.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    vi.stubEnv("ADMIN_EMAIL", "");
    isApprovedEmail("a@x.com");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for an explicit env argument (only the real environment)", () => {
    isApprovedEmail("a@x.com", { ALLOWED_EMAILS: "junk" });
    expect(warn).not.toHaveBeenCalled();
  });
});
