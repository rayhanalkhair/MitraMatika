// Node patch floor (stack-alignment Task 1, rulings R3 and R4). 26.12.1 carries a security fix. The
// version is pinned in .nvmrc (CI's setup-node reads it) and engines.node (>=26.12.1 <27, which
// Vercel resolves to its newest 26.x); MIN_NODE, .nvmrc and engines move together, deliberately
// (scripts/check-node-version.test.ts ties them). This guard proves what really runs: a build on CI
// (CI=true) or Vercel (VERCEL=1) below the floor fails; a local machine below it only gets a
// warning, because the standard asks that CI and Vercel run the pinned Node, not that a laptop
// cannot build. Owner step: install Node 26.x (>= 26.12.1) locally so local builds match.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NODE = "26.12.1";

/** @param {string} version @returns {number[] | null} */
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True when `version` (`v26.12.1` or `26.12.1`) is at least `floor`; a malformed version is below.
 * @param {string} version @param {string} floor @returns {boolean}
 */
export function isAtLeast(version, floor) {
  const found = parse(version);
  const min = parse(floor);
  if (!found || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (found[i] !== min[i]) return found[i] > min[i];
  }
  return true;
}

/**
 * @param {string} version
 * @param {Record<string, string | undefined>} env
 * @returns {{ status: "ok" | "warn" | "fail"; message: string }}
 */
export function checkNode(version, env) {
  if (isAtLeast(version, MIN_NODE)) {
    return { status: "ok", message: `Node ${version} meets the ${MIN_NODE} floor` };
  }
  const message = `Node ${version} is older than ${MIN_NODE} (security fix); use the version in .nvmrc`;
  const buildServer = env.CI === "true" || env.VERCEL === "1";
  if (buildServer) return { status: "fail", message };
  return {
    status: "warn",
    message: `${message}. Building anyway on this local machine; CI and Vercel refuse it.`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { status, message } = checkNode(process.version, process.env);
  if (status === "fail") {
    console.error(message);
    process.exit(1);
  }
  if (status === "warn") console.warn(`Warning: ${message}`);
}
