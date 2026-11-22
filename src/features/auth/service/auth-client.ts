import { createAuthClient } from "better-auth/react";

// Browser-side Better Auth client. Same origin as the app, so no baseURL is needed: it talks to
// /api/auth on whichever host served the page.
export const authClient = createAuthClient();
