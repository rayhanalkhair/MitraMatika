// KaTeX's stylesheet with its fonts inlined as base64 data URIs, so an exported document needs no
// network and no file next to it (the PDF is printed from this very HTML). Only the woff2 faces
// are kept; every browser that can print this HTML reads woff2. Built once and cached.
import "server-only";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

let cached: string | null = null;

function distDir(): string {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  return path.join(path.dirname(require.resolve("katex/package.json")), "dist");
}

/** `src:url(fonts/X.woff2) format("woff2"),url(...woff)...` -> one data URI per face. */
const SRC =
  /src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g;

export function katexInlineCss(): string {
  if (cached !== null) return cached;
  const dir = distDir();
  const css = readFileSync(path.join(dir, "katex.min.css"), "utf8").replace(
    SRC,
    (_match, name: string) => {
      const font = readFileSync(path.join(dir, "fonts", `${name}.woff2`));
      return `src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2")`;
    },
  );
  cached = css;
  return css;
}
