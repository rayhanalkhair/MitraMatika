import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNode, isAtLeast, MIN_NODE } from "./check-node-version.mjs";

describe("the pinned Node version", () => {
  it(".nvmrc pins the full floor version", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe(MIN_NODE);
  });

  it("engines.node starts at the floor and stays on major 26", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE} <27`);
  });
});

describe("isAtLeast", () => {
  it("pins the floor at the patched 26.12.1", () => {
    expect(MIN_NODE).toBe("26.12.1");
  });

  it.each([
    ["v26.12.1", true],
    ["26.12.1", true],
    ["26.13.0", true],
    ["27.0.0", true],
    ["26.12.0", false],
    ["26.9.9", false],
    ["v24.18.0", false],
  ])("%s against 26.12.1 is %s", (version, expected) => {
    expect(isAtLeast(version, "26.12.1")).toBe(expected);
  });

  it("treats a malformed version as below the floor", () => {
    expect(isAtLeast("", "26.12.1")).toBe(false);
    expect(isAtLeast("v26", "26.12.1")).toBe(false);
    expect(isAtLeast("banana", "26.12.1")).toBe(false);
  });
});

describe("checkNode", () => {
  const ci = { CI: "true" };
  const vercel = { VERCEL: "1" };
  const local = {};

  it("passes at or above the floor, on CI and locally", () => {
    expect(checkNode("v26.12.1", ci).status).toBe("ok");
    expect(checkNode("v26.13.0", vercel).status).toBe("ok");
    expect(checkNode("v27.0.0", local).status).toBe("ok");
  });

  it("fails below the floor on CI or Vercel, naming the version found", () => {
    for (const env of [ci, vercel]) {
      const result = checkNode("v24.18.0", env);
      expect(result.status).toBe("fail");
      expect(result.message).toBe(
        "Node v24.18.0 is older than 26.12.1 (security fix); use the version in .nvmrc",
      );
    }
  });

  it("only warns below the floor on a local machine", () => {
    const result = checkNode("v24.18.0", local);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Node v24.18.0 is older than 26.12.1");
    expect(result.message).toContain("CI and Vercel");
  });

  it("fails closed on a malformed version on CI", () => {
    expect(checkNode("banana", ci).status).toBe("fail");
    expect(checkNode("", vercel).status).toBe("fail");
  });

  it("does not treat other CI or VERCEL values as a build server", () => {
    expect(checkNode("v24.18.0", { CI: "false", VERCEL: "0" }).status).toBe("warn");
  });
});

describe("the CLI", () => {
  // Runs the real script in a child Node whose reported version is forced by a preload, so the
  // test does not depend on the Node that runs the suite (no override knob in the script itself).
  function runAs(version: string, env: Record<string, string | undefined>) {
    const preload = `data:text/javascript,Object.defineProperty(process,"version",{value:"${version}"})`;
    const childEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    return spawnSync(
      process.execPath,
      ["--import", preload, join("scripts", "check-node-version.mjs")],
      { encoding: "utf8", env: childEnv as NodeJS.ProcessEnv },
    );
  }

  it("exits 1 with the message below the floor on CI", () => {
    const result = runAs("v26.11.0", { CI: "true", VERCEL: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Node v26.11.0 is older than 26.12.1 (security fix); use the version in .nvmrc",
    );
  });

  it("exits 1 below the floor on Vercel", () => {
    expect(runAs("v24.18.0", { CI: undefined, VERCEL: "1" }).status).toBe(1);
  });

  it("exits 0 with a warning below the floor on a local machine", () => {
    const result = runAs("v24.18.0", { CI: undefined, VERCEL: undefined });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Warning: Node v24.18.0 is older than 26.12.1");
  });

  it("exits 0 silently at the floor on CI", () => {
    const result = runAs("v26.12.1", { CI: "true", VERCEL: undefined });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
