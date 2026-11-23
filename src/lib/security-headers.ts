// Response headers every page and API route gets (security review F6). No Content-Security-Policy
// in this round: the file routes (materials, solver photos, logos) send their own, stricter one.
// Read by next.config.ts (`headers()`), pinned by security-headers.test.ts.

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * Routes that answer with a redirect to a signed object-store URL and send their own
 * `Referrer-Policy: no-referrer` (the exported document, a material, a solver photo): the global
 * policy must not replace it, so they are left out of the Referrer-Policy rule (Next does not
 * overwrite a header set before the handler runs).
 */
export const OWN_REFERRER_POLICY_ROUTES = [
  "api/exports/",
  "api/materials/[^/]+/file",
  "api/solve/[^/]+/photo",
] as const;

/** The camera, microphone and location are never used: the photo inputs use `capture` (the
 *  phone's own camera app), not getUserMedia. */
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";

export function securityHeaders(): HeaderRule[] {
  return [
    {
      // Every path: pages and /api alike.
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        // Same-origin framing only: the assessment preview is a sandboxed srcdoc iframe of the
        // same origin, nothing is framed from another origin.
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
      ],
    },
    {
      source: `/((?!${OWN_REFERRER_POLICY_ROUTES.join("|")}).*)`,
      headers: [{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }],
    },
  ];
}
