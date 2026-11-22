import { getMemoryUploadReceiver } from "@/lib/storage";
import { handleDevUpload } from "@/lib/storage/dev-upload";

// Development and e2e only (Ruling R2): 404 whenever files go to R2 or in production. Uploads
// through the proxy are buffered up to its 10 MB default, so larger files need R2 in development.
export async function PUT(request: Request): Promise<Response> {
  return handleDevUpload(request, getMemoryUploadReceiver);
}
