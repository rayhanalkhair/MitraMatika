import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    }),
}));

import requestConfig from "./request";

interface Config {
  locale: string;
  timeZone: string;
}
const load = () => (requestConfig as unknown as () => Promise<Config>)();

beforeEach(() => {
  jar.clear();
});

describe("request config", () => {
  it("defaults to Indonesian and Asia/Jakarta", async () => {
    expect(await load()).toMatchObject({ locale: "id", timeZone: "Asia/Jakarta" });
  });

  it("takes the viewer timezone from the tz cookie", async () => {
    jar.set("tz", "UTC");
    jar.set("NEXT_LOCALE", "en");
    expect(await load()).toMatchObject({ locale: "en", timeZone: "UTC" });
  });

  it("ignores an invalid tz cookie", async () => {
    jar.set("tz", "Mars/Olympus");
    expect((await load()).timeZone).toBe("Asia/Jakarta");
  });
});
