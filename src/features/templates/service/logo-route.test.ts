import { describe, expect, it, vi } from "vitest";
import { handleLogoRequest } from "./logo-route";

const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const signedIn = () =>
  Promise.resolve({
    ok: true as const,
    data: {
      status: "allowed" as const,
      userId: "u1",
      email: "t@example.test",
      displayName: null,
    },
  });

describe("handleLogoRequest", () => {
  it("streams the owner's logo with locked-down headers", async () => {
    const readLogo = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/svg+xml" },
      }),
    );
    const response = await handleLogoRequest(TEMPLATE_ID, {
      authorize: signedIn,
      readLogo,
    });
    expect(response.status).toBe(200);
    expect(readLogo).toHaveBeenCalledWith("u1", TEMPLATE_ID);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="logo"');
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // An SVG opened directly can run nothing and load nothing.
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("answers 401 to an anonymous caller without reading", async () => {
    const readLogo = vi.fn();
    const response = await handleLogoRequest(TEMPLATE_ID, {
      authorize: () =>
        Promise.resolve({ ok: false as const, error: "unauthenticated" as const }),
      readLogo,
    });
    expect(response.status).toBe(401);
    expect(readLogo).not.toHaveBeenCalled();
  });

  it("answers 404 for another teacher's template, a missing logo or a malformed id", async () => {
    const readLogo = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: "notFound" as const }),
    );
    expect(
      (await handleLogoRequest(TEMPLATE_ID, { authorize: signedIn, readLogo })).status,
    ).toBe(404);
    expect(
      (await handleLogoRequest("../etc", { authorize: signedIn, readLogo })).status,
    ).toBe(404);
    expect(readLogo).toHaveBeenCalledTimes(1);
  });
});
