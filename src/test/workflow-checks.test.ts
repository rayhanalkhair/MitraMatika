import { describe, expect, it } from "vitest";
import {
  code,
  hasShellTracing,
  hasVerboseCurl,
  hasWritePermission,
  jobsOf,
  runsOnPullRequests,
  triggersOf,
  usesPullRequestTarget,
} from "./workflow-checks";

// Synthetic workflows: the checkers must flag every bad form and pass the good ones.
describe("triggersOf", () => {
  it.each([
    ["on: push\n", ["push"]],
    ["on: [push, pull_request]\n", ["push", "pull_request"]],
    ['on: ["push", "pull_request_target"]\n', ["push", "pull_request_target"]],
    ["on: { pull_request: { branches: [main] }, push: }\n", ["pull_request", "push"]],
    ["on:\n  pull_request:\n  push:\n    branches: [main]\n", ["pull_request", "push"]],
    ["on:\n  - push\n  - pull_request\n", ["push", "pull_request"]],
    [
      "on:\n  schedule:\n    - cron: '1 * * * *'\n  workflow_dispatch:\n",
      ["schedule", "workflow_dispatch"],
    ],
    [
      "on: {\n  pull_request_target: {},\n  push: {}\n}\n",
      ["pull_request_target", "push"],
    ],
    ['"on":\n  pull_request:\n', ["pull_request"]],
  ])("reads %j", (yaml, expected) => {
    expect([...triggersOf(yaml)].sort()).toEqual([...expected].sort());
  });

  it("flags pull request triggers in every form", () => {
    expect(runsOnPullRequests("on: [push, pull_request]\n")).toBe(true);
    expect(runsOnPullRequests("on: { pull_request: {} }\n")).toBe(true);
    expect(runsOnPullRequests("on:\n  pull_request_target:\n")).toBe(true);
    expect(runsOnPullRequests("on:\n  schedule:\n    - cron: x\n")).toBe(false);
    expect(usesPullRequestTarget("on: [pull_request_target]\n")).toBe(true);
    expect(usesPullRequestTarget("on:\n  pull_request_target:\n")).toBe(true);
    expect(usesPullRequestTarget("on: pull_request\n")).toBe(false);
  });
});

describe("hasWritePermission", () => {
  it.each([
    "permissions:\n  contents: write\n",
    "jobs:\n  a:\n    permissions:\n      pull-requests: write\n",
    "permissions: write-all\n",
    "permissions: write\n",
    "permissions: { contents: write }\n",
    "    permissions: {contents: read, packages: write}\n",
  ])("flags %j", (yaml) => {
    expect(hasWritePermission(yaml)).toBe(true);
  });

  it.each([
    "permissions:\n  contents: read\n",
    "permissions: read-all\n",
    "permissions: { contents: read }\n",
    "permissions: {}\n",
  ])("passes %j", (yaml) => {
    expect(hasWritePermission(yaml)).toBe(false);
  });
});

describe("hasShellTracing", () => {
  it.each([
    "set -x",
    "set -ex",
    "set -e -x",
    "set -euxo pipefail",
    "set -o xtrace",
    "set -e -o xtrace",
    "bash -x script.sh",
    "set -e \\\n  -x",
  ])("flags %j", (script) => {
    expect(hasShellTracing(script)).toBe(true);
  });

  it.each(["set -euo pipefail", "set -e -u -o pipefail", "set +x"])(
    "passes %j",
    (script) => {
      expect(hasShellTracing(script)).toBe(false);
    },
  );
});

describe("hasVerboseCurl", () => {
  it.each([
    "curl -v https://x",
    "curl -sv https://x",
    "curl --verbose https://x",
    "curl --trace - https://x",
    "curl -sS \\\n  -v \\\n  https://x",
    "curl -fsS https://x \\\n  --verbose",
  ])("flags %j", (script) => {
    expect(hasVerboseCurl(script)).toBe(true);
  });

  it.each([
    "curl -fsS --proto =https https://x",
    "curl -sS \\\n  --max-time 30 \\\n  https://x",
    "echo -v",
  ])("passes %j", (script) => {
    expect(hasVerboseCurl(script)).toBe(false);
  });
});

describe("code and jobsOf", () => {
  it("drops comment lines before any check", () => {
    expect(code("# set -x\non: push\n")).toBe("on: push\n");
  });

  it("finds jobs and their push guard in raw text", () => {
    const jobs = jobsOf(
      "# c\non: push\njobs:\n  a:\n    if: github.event_name == 'push'\n    runs-on: x\n  b:\n    runs-on: x\n",
    );
    expect(jobs.map((j) => [j.name, j.guardedToPush])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});
