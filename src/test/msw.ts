import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";

export { http, HttpResponse };

/**
 * The shared MSW server for tests that exercise real `fetch` calls (client hooks, external HTTP).
 * `setup.ts` starts it for every jsdom test file with `onUnhandledRequest: "error"`; a Node-environment
 * test that needs it imports it and calls `server.listen` itself.
 */
export const server = setupServer();

/** Register handlers for the current test; `afterEach` resets them. */
export function useHandlers(...handlers: RequestHandler[]): void {
  server.use(...handlers);
}

/**
 * A GET handler that answers with JSON and records every request it saw, so a test can assert
 * how often the URL was called and with which method and headers.
 */
export function recordJson(path: string, body: unknown, init: { status?: number } = {}) {
  const requests: Request[] = [];
  const handler = http.get(path, ({ request }) => {
    requests.push(request.clone());
    return HttpResponse.json(body as Record<string, unknown>, {
      status: init.status ?? 200,
    });
  });
  return { handler, requests };
}
