import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../../messages/en.json";
import idMessages from "../../../messages/id.json";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: getMock, set: vi.fn() }),
}));

import { defaultLocale, isLocale, LOCALE_COOKIE, locales } from "./config";
import requestConfig from "./request";

type Resolve = (params: {
  requestLocale: Promise<string | undefined>;
}) => Promise<{ locale: string; messages: unknown }>;
const resolve = requestConfig as unknown as Resolve;
const run = () => resolve({ requestLocale: Promise.resolve(undefined) });

beforeEach(() => {
  getMock.mockReset();
});

describe("i18n config", () => {
  it("is Indonesian by default with English available", () => {
    expect(locales).toEqual(["id", "en"]);
    expect(defaultLocale).toBe("id");
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  it("accepts only the declared locales", () => {
    expect(isLocale("id")).toBe(true);
    expect(isLocale("en")).toBe(true);
    for (const value of ["fr", "", "EN", "id-ID", null, undefined, 1, {}, "__proto__"]) {
      expect(isLocale(value)).toBe(false);
    }
  });
});

describe("request locale resolution (Review Focus 5)", () => {
  it("falls back to id when the cookie is missing", async () => {
    getMock.mockReturnValue(undefined);
    const result = await run();
    expect(result.locale).toBe("id");
    expect(result.messages).toEqual(idMessages);
    expect(getMock).toHaveBeenCalledWith("NEXT_LOCALE");
  });

  it.each(["fr", "", "EN", "id-ID", "../../etc/passwd", "__proto__", "constructor"])(
    "falls back to id for the garbage cookie %j without crashing",
    async (value) => {
      getMock.mockReturnValue({ name: "NEXT_LOCALE", value });
      const result = await run();
      expect(result.locale).toBe("id");
      expect(result.messages).toEqual(idMessages);
    },
  );

  it("falls back to id for a cookie without a value", async () => {
    getMock.mockReturnValue({ name: "NEXT_LOCALE" });
    expect((await run()).locale).toBe("id");
  });

  it("serves the English catalog for the en cookie", async () => {
    getMock.mockReturnValue({ name: "NEXT_LOCALE", value: "en" });
    const result = await run();
    expect(result.locale).toBe("en");
    expect(result.messages).toEqual(enMessages);
  });

  it("serves the Indonesian catalog for the id cookie", async () => {
    getMock.mockReturnValue({ name: "NEXT_LOCALE", value: "id" });
    expect((await run()).locale).toBe("id");
  });
});
