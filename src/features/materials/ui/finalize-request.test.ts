import { afterEach, describe, expect, it, vi } from "vitest";
import { FINALIZE_PATH, requestFinalize } from "./finalize-request";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(answer: () => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("requestFinalize", () => {
  it("POSTs JSON to the finalise route and returns its typed answer", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(Response.json({ ok: true, materialId: "m1" })),
    );
    expect(await requestFinalize({ objectKey: "k", title: "Buku" })).toEqual({
      ok: true,
      materialId: "m1",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FINALIZE_PATH);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ objectKey: "k", title: "Buku" });
  });

  it("passes a typed refusal through", async () => {
    stubFetch(() => Promise.resolve(Response.json({ ok: false, error: "zipBomb" })));
    expect(await requestFinalize({ objectKey: "k", title: "Buku" })).toEqual({
      ok: false,
      error: "zipBomb",
    });
  });

  it("maps a lost connection, a signed-out answer and an unreadable one", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await requestFinalize({ objectKey: "k", title: "B" })).toEqual({
      ok: false,
      error: "network",
    });
    stubFetch(() => Promise.resolve(new Response("nope", { status: 401 })));
    expect(await requestFinalize({ objectKey: "k", title: "B" })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    // Signed out: the proxy redirects to /sign-in and fetch follows it to an HTML page.
    stubFetch(() => {
      const page = new Response("<html>Masuk</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(page, "redirected", { value: true });
      return Promise.resolve(page);
    });
    expect(await requestFinalize({ objectKey: "k", title: "B" })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    stubFetch(() => Promise.resolve(Response.json({ weird: true }, { status: 502 })));
    expect(await requestFinalize({ objectKey: "k", title: "B" })).toEqual({
      ok: false,
      error: "generic",
    });
  });
});
