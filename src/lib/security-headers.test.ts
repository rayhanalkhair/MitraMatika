import { describe, expect, it } from "vitest";
import config from "../../next.config";
import { securityHeaders } from "./security-headers";

const byKey = (headers: { key: string; value: string }[]) =>
  Object.fromEntries(headers.map((header) => [header.key, header.value]));

describe("security headers", () => {
  const rules = securityHeaders();
  const everywhere = rules.find((rule) => rule.source === "/:path*");
  const referrer = rules.find((rule) =>
    rule.headers.some((h) => h.key === "Referrer-Policy"),
  );

  it("pins the header set for every path (pages and /api)", () => {
    expect(everywhere).toBeDefined();
    expect(byKey(everywhere?.headers ?? [])).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    // No CSP in this round.
    expect(JSON.stringify(rules)).not.toContain("Content-Security-Policy");
  });

  it("sends the referrer policy everywhere except the routes that set no-referrer themselves", () => {
    expect(byKey(referrer?.headers ?? [])).toEqual({
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    const group = /^\/\((.*)\)$/.exec(referrer?.source ?? "")?.[1];
    expect(group).toBeDefined();
    const applies = (path: string) => new RegExp(`^/${group ?? ""}$`).test(path);
    for (const path of [
      "/",
      "/home",
      "/materials/abc",
      "/api/health",
      "/api/auth/sign-in/email",
      "/api/materials/finalize",
      "/api/templates/abc/logo",
    ]) {
      expect(applies(path), path).toBe(true);
    }
    for (const path of [
      "/api/exports/abc",
      "/api/materials/abc/file",
      "/api/solve/abc/photo",
    ]) {
      expect(applies(path), path).toBe(false);
    }
  });

  it("is wired into next.config.ts", async () => {
    const resolved = config("phase-production-build");
    expect(await (resolved.headers?.() ?? [])).toEqual(rules);
  });
});
