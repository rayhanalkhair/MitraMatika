import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyPdfjsAssets } from "./copy-pdfjs-assets.mjs";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("copyPdfjsAssets", () => {
  it("copies pdf.js's decoders, colour profiles and standard fonts under its version", () => {
    const target = mkdtempSync(join(tmpdir(), "pdfjs-"));
    made.push(target);
    const version = (
      JSON.parse(readFileSync("node_modules/pdfjs-dist/package.json", "utf8")) as {
        version: string;
      }
    ).version;
    expect(copyPdfjsAssets(process.cwd(), target)).toBe(join(target, version));
    for (const file of [
      "wasm/jbig2.wasm",
      "wasm/openjpeg.wasm",
      "wasm/jbig2_nowasm_fallback.js",
      "wasm/openjpeg_nowasm_fallback.js",
      "wasm/qcms_bg.wasm",
      "iccs/CGATS001Compat-v2-micro.icc",
      "standard_fonts/LiberationSans-Regular.ttf",
    ]) {
      expect(existsSync(join(target, version, file)), file).toBe(true);
    }
  });
});
