import { afterAll, afterEach, beforeAll, vi } from "vitest";

// `next-intl/server` resolves to its client build under plain Node (no react-server condition)
// and throws. Server Components and actions get a translator built from the real catalogs.
vi.mock("next-intl/server", async () => {
  const { createStaticTranslator } = await import("@/lib/i18n/translator");
  const { getTestLocale, getTestTimeZone } = await import("./intl-server");
  type Options = { locale?: "id" | "en"; namespace?: string } | string | undefined;
  const getTranslations = (options?: Options) => {
    const namespace = typeof options === "string" ? options : options?.namespace;
    const locale =
      (typeof options === "object" ? options.locale : undefined) ?? getTestLocale();
    return Promise.resolve(
      (createStaticTranslator as (ns?: string, locale?: "id" | "en") => unknown)(
        namespace,
        locale,
      ),
    );
  };
  return {
    getTranslations,
    getLocale: () => Promise.resolve(getTestLocale()),
    getMessages: async () => {
      const { default: id } = await import("../../messages/id.json");
      const { default: en } = await import("../../messages/en.json");
      return getTestLocale() === "en" ? en : id;
    },
    getTimeZone: () => Promise.resolve(getTestTimeZone()),
    getFormatter: async () => {
      const { createFormatter } = await import("next-intl");
      return createFormatter({ locale: getTestLocale(), timeZone: getTestTimeZone() });
    },
    getRequestConfig: <T>(config: T) => config,
    setRequestLocale: () => undefined,
  };
});

// MSW only where `fetch` can run client code: DOM-environment test files. Node-environment tests
// (the DB suites) never load it, so they pay no start-up cost, and an unmocked request in a jsdom
// test fails loudly instead of reaching the network.
if (typeof document !== "undefined") {
  const { server } = await import("./msw");
  // msw 3 renamed `onUnhandledRequest` to `onUnhandledFrame`.
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
}
