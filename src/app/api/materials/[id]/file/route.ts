import { authorizeAction } from "@/features/auth";
import { handleMaterialFileRequest } from "@/features/materials";
import { getDb } from "@/lib/db/runtime";
import { getMemoryUploadReceiver, getObjectStore } from "@/lib/storage";

// The stored file of one of the signed-in teacher's materials, for the page viewer: a 302 to a
// 300 s signed URL (R2), the bytes themselves in development and e2e (memory store), 404 for
// anything that is not theirs (src/features/materials/service/file-route.ts).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleMaterialFileRequest(id, {
    authorize: authorizeAction,
    db: getDb(),
    store: getObjectStore,
    inline: () => getMemoryUploadReceiver() !== null,
  });
}
