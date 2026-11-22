import { authorizeAction } from "@/features/auth";
import { handleExportDownload } from "@/features/export";
import { getDb } from "@/lib/db/runtime";
import { getObjectStore } from "@/lib/storage";

// One exported file of the signed-in teacher: 302 to a 300 s signed URL, 404 for anything that is
// not theirs, 410 once it has expired or belongs to an earlier approval (R27,
// src/features/export/service/download.ts).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleExportDownload(id, {
    authorize: authorizeAction,
    db: getDb(),
    store: getObjectStore,
  });
}
