import { authorizeAction } from "@/features/auth";
import { handleLogoRequest, readLogo } from "@/features/templates";
import { getDb } from "@/lib/db/runtime";
import { getObjectStore } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleLogoRequest(id, {
    authorize: authorizeAction,
    // Under RLS as the signed-in teacher: another teacher's template is simply not found.
    readLogo: (userId, templateId) =>
      readLogo(getObjectStore(), getDb(), {
        ownerId: userId,
        templateId,
      }),
  });
}
