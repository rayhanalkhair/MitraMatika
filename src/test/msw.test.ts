// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { http, HttpResponse, recordJson, server, useHandlers } from "./msw";

describe("shared MSW server", () => {
  it("fails a request nobody mocked, naming MSW as the cause", async () => {
    const error = await fetch("http://localhost:3999/api/unmocked").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // A real network failure would be ECONNREFUSED; MSW's error says the request had no handler.
    expect(String((error as Error).cause)).toMatch(/unhandled|no.*handler|intercept/i);
  });

  it("serves handlers registered for one test", async () => {
    const { handler, requests } = recordJson("/api/ping", { ok: true });
    useHandlers(handler);
    const response = await fetch("/api/ping", {
      headers: { accept: "application/json" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("resets handlers between tests", async () => {
    // The handler of the previous test is gone: the same path is now an unhandled request, not
    // merely a failed one (a refused connection would also reject).
    const error = await fetch("/api/ping").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).cause)).toMatch(/unhandled|no.*handler|intercept/i);
  });

  it("can answer errors", async () => {
    server.use(http.get("/api/boom", () => HttpResponse.json({}, { status: 500 })));
    expect((await fetch("/api/boom")).status).toBe(500);
  });
});
