import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { assertBuildEnv } from "./src/lib/env";
import { securityHeaders } from "./src/lib/security-headers";

// The locale comes from a cookie (no URL prefix); the request config reads it per request.
const withNextIntl = createNextIntlPlugin("./src/lib/i18n/request.ts");

// Files read at run time through an fs path that the tracer cannot see: KaTeX's CSS and fonts
// (katex-assets.ts, inlined into the HTML preview). The PDF renderer (React-PDF) needs none: it is
// on Next's built-in serverExternalPackages list and the tracer follows its imports. With pnpm,
// node_modules/<pkg> is a symlink into node_modules/.pnpm, so both the link and the real folder
// are listed.
const KATEX_FILES = [
  // require.resolve("katex/package.json") locates the dist folder.
  "./node_modules/katex/package.json",
  "./node_modules/.pnpm/katex@*/node_modules/katex/package.json",
  "./node_modules/katex/dist/katex.min.css",
  "./node_modules/katex/dist/fonts/*.woff2",
  "./node_modules/.pnpm/katex@*/node_modules/katex/dist/katex.min.css",
  "./node_modules/.pnpm/katex@*/node_modules/katex/dist/fonts/*.woff2",
];
// Ruling R10: PDFs are parsed in a worker thread (src/features/materials/service/pdf.worker.mjs).
// The bundler copies the worker file as an asset without bundling it, so its bare `unpdf` import
// is resolved from node_modules at run time and must be traced into every function that parses
// a PDF: the upload's finalise route (/api/materials/finalize, R16) and the job runner (ingestion).
const UNPDF_FILES = [
  "./node_modules/unpdf/package.json",
  "./node_modules/unpdf/dist/**",
  "./node_modules/.pnpm/unpdf@*/node_modules/unpdf/package.json",
  "./node_modules/.pnpm/unpdf@*/node_modules/unpdf/dist/**",
];
// Ruling R15: Word files are read in a worker thread too (docx.worker.mjs), copied unbundled the
// same way, so jszip, mammoth and saxes resolve from node_modules at run time together with every
// package they load. The list is their dependency closure in the lockfile; each package's .pnpm
// folder holds the package and the links to its own dependencies. A function that misses one does
// not fail the file: ingestion probes the packages first and waits (dependencies.ts).
const DOCX_PACKAGES = [
  "@xmldom+xmldom",
  "argparse",
  "base64-js",
  "core-util-is",
  "dingbat-to-unicode",
  "duck",
  "immediate",
  "inherits",
  "isarray",
  "jszip",
  "lie",
  "lop",
  "mammoth",
  "option",
  "pako",
  "process-nextick-args",
  "readable-stream",
  "safe-buffer",
  "saxes",
  "setimmediate",
  "sprintf-js",
  "string_decoder",
  "underscore",
  "util-deprecate",
  "xmlbuilder",
  "xmlchars",
];
const DOCX_FILES = [
  "./node_modules/jszip/**",
  "./node_modules/mammoth/**",
  "./node_modules/saxes/**",
  ...DOCX_PACKAGES.map((name) => `./node_modules/.pnpm/${name}@*/node_modules/**`),
];
// The functions that start the job runner most often carry both parsers (R15): the tick and the
// status poll, and the pages listed below. Not every page whose action calls scheduleRun is
// listed (/solve, /solve/[id], /trash and the review's regenerate action are not): an ingestion
// job claimed in a function without the parsers finds no probe worker and defers until a route
// that has them (the tick or a status poll) runs it, so a restored material may wait for one.
// Checked with `next build` (.nft.json): the route handlers (/api/jobs/run, /api/jobs/[id],
// /api/e2e/control) carry the packages and the emitted worker files. The pages (/generate,
// /generate/[requestId], /assessment-builder/[id], /materials) carry the packages, but the build
// does not trace the worker files into a page's function (a glob on .next/server/assets is not
// honoured either): an ingestion job claimed there finds no probe worker and waits for a route.
const INGEST_FILES = [...UNPDF_FILES, ...DOCX_FILES];

// Fails `next build` on an invalid environment (skipped with SKIP_ENV_VALIDATION=1 in CI).
export default function config(phase: string): NextConfig {
  assertBuildEnv(phase);
  return withNextIntl({
    // Security response headers on every page and API route (src/lib/security-headers.ts).
    headers: () => Promise.resolve(securityHeaders()),
    outputFileTracingIncludes: {
      // Every function that starts the job runner carries the parsers (ingestion): the scheduled
      // tick, the job status poll (it kicks a due job) and the builder page (its export action
      // schedules a run). An export needs no extra files.
      "/api/jobs/run": INGEST_FILES,
      "/api/jobs/\\[id\\]": INGEST_FILES,
      "/assessment-builder/\\[id\\]": INGEST_FILES,
      // The upload's finalise route parses the file in a worker (R16: only route handlers carry
      // the emitted worker files) and starts the runner for the new material's ingestion.
      "/api/materials/finalize": INGEST_FILES,
      // The materials pages: the structure proposal action (/materials/[id]) starts the runner.
      "/materials": INGEST_FILES,
      // The other functions that start the runner: generation and regeneration (the /generate
      // page and its review page /generate/[requestId]) and the e2e control route.
      "/generate": INGEST_FILES,
      "/api/e2e/control": INGEST_FILES,
      // The preview inlines KaTeX's CSS and fonts.
      "/assessment-builder/\\[id\\]/preview": KATEX_FILES,
    },
    experimental: {
      // A school logo (at most 1 MB) is posted to a Server Action as multipart form data; the
      // default 1 MB body limit would refuse it with its part headers. The action checks the size.
      serverActions: { bodySizeLimit: "1100kb" },
    },
  });
}
