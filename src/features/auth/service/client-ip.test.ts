import { describe, expect, it } from "vitest";
import {
  CLIENT_IP_HEADER,
  ipLimitSubject,
  requestWithClientIp,
  resolveClientIp,
  withClientIp,
} from "./client-ip";
import { ipDailyIdentifier } from "./ip-daily-limit";

const h = (entries: Record<string, string>) => new Headers(entries);
const OFF = {};
const ON = { VERCEL: "1" };

describe("resolveClientIp off Vercel", () => {
  it("uses the rightmost x-forwarded-for address, never the spoofed leftmost", () => {
    expect(
      resolveClientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }), OFF),
    ).toBe("203.0.113.9");
  });

  it("uses a single valid x-forwarded-for address", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.4" }), OFF)).toBe(
      "198.51.100.4",
    );
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    expect(
      resolveClientIp(
        h({ "x-real-ip": "192.0.2.1", "x-forwarded-for": "198.51.100.4" }),
        OFF,
      ),
    ).toBe("192.0.2.1");
  });

  it("falls back to x-forwarded-for when x-real-ip is garbage", () => {
    expect(
      resolveClientIp(
        h({ "x-real-ip": "not-an-ip", "x-forwarded-for": "198.51.100.4" }),
        OFF,
      ),
    ).toBe("198.51.100.4");
  });

  it("ignores x-vercel-forwarded-for", () => {
    expect(resolveClientIp(h({ "x-vercel-forwarded-for": "192.0.2.50" }), OFF)).toBe(
      undefined,
    );
  });

  it.each([
    "garbage",
    "1.2.3.4:8080",
    "[2001:db8::1]",
    "[2001:db8::1]:443",
    "fe80::1%eth0",
    "999.1.1.1",
    "",
    " , ",
  ])("drops %j", (value) => {
    expect(resolveClientIp(h({ "x-forwarded-for": value }), OFF)).toBeUndefined();
  });

  it("trims whitespace and accepts IPv6", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "1.1.1.1,  2001:db8::7 " }), OFF)).toBe(
      "2001:db8::7",
    );
  });

  it("does not take a valid left address when the rightmost is garbage", () => {
    expect(
      resolveClientIp(h({ "x-forwarded-for": "198.51.100.4, garbage" }), OFF),
    ).toBeUndefined();
  });
});

describe("resolveClientIp on Vercel", () => {
  it("uses only x-vercel-forwarded-for, even if the client sends the others", () => {
    expect(
      resolveClientIp(
        h({
          "x-vercel-forwarded-for": "203.0.113.20",
          "x-forwarded-for": "6.6.6.6",
          "x-real-ip": "7.7.7.7",
        }),
        ON,
      ),
    ).toBe("203.0.113.20");
  });

  it("does not fall back to the other headers", () => {
    expect(
      resolveClientIp(h({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }), ON),
    ).toBeUndefined();
    expect(
      resolveClientIp(
        h({ "x-vercel-forwarded-for": "garbage", "x-real-ip": "7.7.7.7" }),
        ON,
      ),
    ).toBeUndefined();
  });

  it("reads VERCEL from process.env at call time by default", () => {
    const headers = h({
      "x-vercel-forwarded-for": "203.0.113.21",
      "x-real-ip": "7.7.7.7",
    });
    const before = process.env.VERCEL;
    try {
      delete process.env.VERCEL;
      expect(resolveClientIp(headers)).toBe("7.7.7.7");
      process.env.VERCEL = "1";
      expect(resolveClientIp(headers)).toBe("203.0.113.21");
    } finally {
      if (before === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = before;
    }
  });
});

describe("withClientIp", () => {
  it("overwrites a client supplied dedicated header", () => {
    const out = withClientIp(
      h({ [CLIENT_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "198.51.100.4" }),
      OFF,
    );
    expect(out.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
  });

  it("removes a client supplied dedicated header when nothing resolves", () => {
    expect(
      withClientIp(h({ [CLIENT_IP_HEADER]: "6.6.6.6" }), OFF).has(CLIENT_IP_HEADER),
    ).toBe(false);
  });
});

describe("requestWithClientIp", () => {
  // Under Next on Vercel the incoming request is not this module's global Request class, and
  // `new Request(thatRequest)` fails ("Failed to parse URL from [object Request]"). A duck typed
  // stand-in reproduces that: only a rebuild from parts can handle it.
  const foreign = (method: string, body?: string) => ({
    url: "http://localhost:3000/api/auth/sign-in/social",
    method,
    headers: new Headers({
      "content-type": "application/json",
      [CLIENT_IP_HEADER]: "6.6.6.6",
    }),
    signal: new AbortController().signal,
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body ?? "").buffer),
  });

  it("rebuilds a foreign POST request from its parts with the body and a clean IP header", async () => {
    const rebuilt = await requestWithClientIp(
      foreign("POST", '{"provider":"google"}') as unknown as Request,
      { VERCEL: "1" },
    );
    expect(rebuilt.method).toBe("POST");
    expect(rebuilt.url).toBe("http://localhost:3000/api/auth/sign-in/social");
    expect(await rebuilt.text()).toBe('{"provider":"google"}');
    expect(rebuilt.headers.get("content-type")).toBe("application/json");
    expect(rebuilt.headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("rebuilds a foreign GET request without a body", async () => {
    const rebuilt = await requestWithClientIp(foreign("GET") as unknown as Request, {});
    expect(rebuilt.method).toBe("GET");
    expect(rebuilt.body).toBeNull();
  });

  it("sets the resolved address and drops a spoofed one", async () => {
    const request = new Request("http://localhost:3000/api/auth/ok", {
      headers: {
        [CLIENT_IP_HEADER]: "6.6.6.6",
        "x-vercel-forwarded-for": "203.0.113.9",
      },
    });
    const rebuilt = await requestWithClientIp(request, { VERCEL: "1" });
    expect(rebuilt.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.9");
  });
});

describe("ipLimitSubject", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(ipLimitSubject("203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by their /64, however they are written", () => {
    const a = ipLimitSubject("2001:db8:abcd:12:1::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(ipLimitSubject("2001:0DB8:abcd:0012:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipLimitSubject("2001:db8:abcd:13::1")).not.toBe(a);
    expect(ipLimitSubject("::1")).toBe("0:0:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(ipLimitSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("keeps anything else as given (the caller only passes validated IPs or a fixed key)", () => {
    expect(ipLimitSubject("no-trusted-ip")).toBe("no-trusted-ip");
  });
});

describe("per-IP limit keys", () => {
  const SECRET = "test-secret-".padEnd(40, "x");
  it("share one daily key for two IPv6 addresses of one /64, and keep IPv4 addresses apart", () => {
    const key = (ip: string) => ipDailyIdentifier(SECRET, "/sign-up/email", ip);
    expect(key("2001:db8:abcd:12::1")).toBe(key("2001:db8:abcd:12:ffff::2"));
    expect(key("2001:db8:abcd:12::1")).not.toBe(key("2001:db8:abcd:13::1"));
    expect(key("203.0.113.1")).not.toBe(key("203.0.113.2"));
    expect(key("::ffff:203.0.113.1")).toBe(key("203.0.113.1"));
  });
});
