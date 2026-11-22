// Copies the files pdf.js fetches at run time into public/pdfjs/<version>/ (Task 6 review I1):
// the image decoders of scanned pages (JBIG2, CCITT, JPEG 2000: wasm/ and their JS fallbacks),
// the colour profile (iccs/) and the standard fonts (standard_fonts/). They are served from this
// origin, never a CDN; the browser renderer (src/features/materials/ui/pdf-render.ts) points
// pdf.js at them. Run before `next dev` and `next build`; the folder is not committed.
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FOLDERS = ["wasm", "iccs", "standard_fonts"];

/** Copies the folders under `<target>/<version>/` (stale versions removed); returns that path. */
export function copyPdfjsAssets(root, target = join(root, "public", "pdfjs")) {
  const source = join(root, "node_modules", "pdfjs-dist");
  const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  rmSync(target, { recursive: true, force: true });
  const destination = join(target, version);
  mkdirSync(destination, { recursive: true });
  for (const folder of FOLDERS) {
    cpSync(join(source, folder), join(destination, folder), { recursive: true });
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyPdfjsAssets(process.cwd());
}
