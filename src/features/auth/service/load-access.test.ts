import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAuthPort } from "./fake-port";
import { loadAccess, type AccessDeps } from "./load-access";

afterEach(() => {
  vi.unstubAllEnvs();
});

function deps(overrides: Partial<AccessDeps> = {}): AccessDeps {
  return {
    getPort: () => Promise.resolve(createFakeAuthPort()),
    readE2eCookie: () => Promise.resolve(undefined),
    ...overrides,
  };
}

const withUser = (id: string, email: string) =>
  createFakeAuthPort({ getSessionUser: { user: { id, email } } });

describe("loadAccess (real path)", () => {
  it("returns allowed for a signed-in account", async () => {
    const access = await loadAccess(
      deps({
        getPort: () => Promise.resolve(withUser("user-1", "Teacher@Example.test")),
      }),
    );
    expect(access).toMatchObject({ status: "allowed", userId: "user-1" });
  });

  it("returns allowed for any email: there is no allowlist", async () => {
    const access = await loadAccess(
      deps({
        getPort: () => Promise.resolve(withUser("u2", "x@example.test")),
      }),
    );
    expect(access).toMatchObject({ status: "allowed", email: "x@example.test" });
  });

  it("returns anonymous when there is no session", async () => {
    expect(await loadAccess(deps())).toEqual({ status: "anonymous" });
  });

  it("returns anonymous when the port cannot be created", async () => {
    const access = await loadAccess(
      deps({ getPort: () => Promise.reject(new Error("no env")) }),
    );
    expect(access).toEqual({ status: "anonymous" });
  });

  it("returns anonymous when reading the session throws", async () => {
    const access = await loadAccess(
      deps({
        getPort: () =>
          Promise.resolve(
            createFakeAuthPort({ getSessionUser: { throws: new Error("down") } }),
          ),
      }),
    );
    expect(access).toEqual({ status: "anonymous" });
  });

  it("ignores the e2e cookie when the seam is off", async () => {
    const readE2eCookie = vi.fn(() => Promise.resolve("teacher@example.test"));
    const access = await loadAccess(deps({ readE2eCookie }));
    expect(access).toEqual({ status: "anonymous" });
    expect(readE2eCookie).not.toHaveBeenCalled();
  });
});

describe("loadAccess (e2e fake session)", () => {
  const enable = () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "development");
  };

  it("uses the cookie and never touches Better Auth", async () => {
    enable();
    const getPort = vi.fn(() => Promise.resolve(createFakeAuthPort()));
    const access = await loadAccess(
      deps({ getPort, readE2eCookie: () => Promise.resolve("teacher@example.test") }),
    );
    expect(access).toMatchObject({ status: "allowed", email: "teacher@example.test" });
    expect(getPort).not.toHaveBeenCalled();
  });

  it("treats any cookie other than the fixed test identity as anonymous", async () => {
    enable();
    const getPort = vi.fn(() => Promise.resolve(createFakeAuthPort()));
    const access = await loadAccess(
      deps({ getPort, readE2eCookie: () => Promise.resolve("x@example.test") }),
    );
    expect(access).toEqual({ status: "anonymous" });
    expect(getPort).not.toHaveBeenCalled();
  });

  it("is anonymous without a cookie", async () => {
    enable();
    expect(await loadAccess(deps())).toEqual({ status: "anonymous" });
  });

  it("falls back to the real path in production", async () => {
    enable();
    vi.stubEnv("NODE_ENV", "production");
    const readE2eCookie = vi.fn(() => Promise.resolve("teacher@example.test"));
    const access = await loadAccess(deps({ readE2eCookie }));
    expect(access).toEqual({ status: "anonymous" });
    expect(readE2eCookie).not.toHaveBeenCalled();
  });
});
