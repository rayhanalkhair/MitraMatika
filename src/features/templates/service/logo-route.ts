import type { ActionAuthorization } from "@/features/auth";
import type { Result } from "@/lib/result";
import { isUuid } from "./templates";

// GET /api/templates/[id]/logo: the owner's logo, streamed from the object store (no public URL,
// no signed URL). Another teacher's template, a trashed one or a missing logo is a plain 404.
export async function handleLogoRequest(
  templateId: string,
  deps: {
    authorize: () => Promise<ActionAuthorization>;
    readLogo: (
      userId: string,
      templateId: string,
    ) => Promise<Result<{ bytes: Uint8Array; contentType: string }, "notFound">>;
  },
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) return new Response(null, { status: 401 });
  if (!isUuid(templateId)) return new Response(null, { status: 404 });

  const logo = await deps.readLogo(authorization.data.userId, templateId);
  if (!logo.ok) return new Response(null, { status: 404 });
  // A copy typed on a plain ArrayBuffer, which BodyInit requires.
  return new Response(new Uint8Array(logo.data.bytes), {
    status: 200,
    headers: {
      "Content-Type": logo.data.contentType,
      "Content-Length": String(logo.data.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Shown, never downloaded; no name of the school or teacher in the file name.
      "Content-Disposition": 'inline; filename="logo"',
      "Cross-Origin-Resource-Policy": "same-origin",
      // Defence in depth for an SVG opened on its own: nothing runs and nothing loads.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
