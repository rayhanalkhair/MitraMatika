import { AiImageError, type AiImage } from "./types";

// Groq refuses base64 image requests over 4 MB in total; the images may use 3.5 MiB of it, which
// leaves room for the data-URL prefixes, the prompt and the JSON envelope.
export const MAX_IMAGES_BASE64_CHARS = 3.5 * 1024 * 1024;
// Groq's vision models take at most 5 images per request; one page or photo needs 1.
export const MAX_IMAGES_PER_REQUEST = 4;

// Bare base64 only: the standard alphabet, a length that is a multiple of 4, at most two "=" at
// the end. Anything else could break out of the data URL it is put into.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const SIGNATURES: Record<string, readonly number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

function startsWith(base64: string, signature: readonly number[]): boolean {
  // 12 base64 characters decode to 9 bytes, enough for either signature.
  const head = atob(base64.slice(0, 12));
  return signature.every((byte, i) => head.charCodeAt(i) === byte);
}

/**
 * Throws `AiImageError` unless every image is PNG or JPEG (by its declared type AND its first
 * bytes), is valid bare base64, and the images fit the per-request count and size limits. Called
 * by the gateway before anything leaves, and again by each provider that builds a data URL.
 */
export function checkImages(images: readonly AiImage[]): void {
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    throw new AiImageError(
      "too_many_images",
      "Terlalu banyak gambar dalam satu permintaan.",
    );
  }
  // The total first, so an oversized string is never scanned.
  const total = images.reduce((sum, image) => sum + image.base64.length, 0);
  if (total > MAX_IMAGES_BASE64_CHARS) {
    throw new AiImageError(
      "image_too_large",
      "Gambar terlalu besar untuk dikirim ke AI.",
    );
  }
  for (const image of images) {
    const signature = SIGNATURES[image.mime] as readonly number[] | undefined;
    if (!signature) {
      throw new AiImageError(
        "image_type_unsupported",
        "Gambar harus berformat PNG atau JPEG.",
      );
    }
    if (image.base64.length === 0 || !BASE64.test(image.base64)) {
      throw new AiImageError("image_invalid", "Data gambar tidak valid.");
    }
    if (!startsWith(image.base64, signature)) {
      throw new AiImageError(
        "image_type_unsupported",
        "Gambar harus berformat PNG atau JPEG.",
      );
    }
  }
}
