// The browser redraws every photo before it is uploaded: the drawing applies the camera's
// orientation and leaves its metadata (Exif GPS, device, time) behind, and a photo larger than
// the vision model accepts (bytes or pixels) comes out smaller (longest side 2,000 px, then less).
// A browser that cannot redraw it sends the file as it is when it fits. Browser only; the server
// strips the metadata and checks the bytes whatever happens here.
import { MAX_SOLVER_PHOTO_BYTES } from "../schema/solver";

const LONGEST_SIDES = [2_000, 1_600, 1_200];

/** The redrawn photo, else the file itself when it fits, else null (it cannot be made to fit). */
export async function shrinkPhoto(file: File): Promise<File | null> {
  const fallback = file.size <= MAX_SOLVER_PHOTO_BYTES ? file : null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return fallback;
  }
  try {
    for (const side of LONGEST_SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return fallback;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.85);
      });
      if (blob && blob.size <= MAX_SOLVER_PHOTO_BYTES) {
        return new File([blob], "photo.jpg", { type: "image/jpeg" });
      }
    }
    return fallback;
  } finally {
    bitmap.close();
  }
}
