import { authorizeAction } from "@/features/auth";
import { handleSolverPhotoRequest } from "@/features/solver";
import { getDb } from "@/lib/db/runtime";
import { getMemoryUploadReceiver, getObjectStore } from "@/lib/storage";

// The photo of one of the signed-in teacher's solver sessions, for the confirmation of its
// reading: a 302 to a 300 s signed URL (R2), the bytes themselves in development and e2e (memory
// store), 404 for anything that is not theirs (src/features/solver/service/photo-route.ts).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleSolverPhotoRequest(id, {
    authorize: authorizeAction,
    db: getDb(),
    store: getObjectStore,
    inline: () => getMemoryUploadReceiver() !== null,
  });
}
