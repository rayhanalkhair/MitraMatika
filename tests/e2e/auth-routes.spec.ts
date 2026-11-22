import { expect, test } from "@playwright/test";
import { ANONYMOUS_STATE } from "./auth";

// Calls the real Better Auth route (no fake-auth bypass applies to /api/auth/*) with dummy Google
// credentials from playwright.config.ts. It needs no real account: the route only builds the
// Google authorisation URL. It exists because a crash in the route's own request handling once
// shipped to Vercel unseen (unit tests run in one realm, the other e2e specs use the fake session).
test.use({ storageState: ANONYMOUS_STATE });

test("POST /api/auth/sign-in/social answers with a Google authorisation URL", async ({
  request,
}) => {
  const response = await request.post("/api/auth/sign-in/social", {
    headers: { origin: "http://localhost:3000" },
    data: { provider: "google", callbackURL: "/auth/callback" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { url?: string };
  expect(body.url?.startsWith("https://accounts.google.com/")).toBe(true);
});

test("GET /api/auth/ok answers", async ({ request }) => {
  const response = await request.get("/api/auth/ok");
  expect(response.status()).toBe(200);
});
