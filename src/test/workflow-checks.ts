// Pure checkers for the workflow-file tests. They work on YAML text (no YAML parser is a direct
// dependency), so each one is proven against synthetic bad workflows in workflow-checks.test.ts.

export interface Job {
  name: string;
  text: string;
  guardedToPush: boolean;
}

// Code lines only: comments may mention secrets or triggers freely.
export function code(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

// Joins `\` continuation lines, so a flag on the next line is seen next to its command.
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

// Event names under the top-level `on:` key in any YAML form: scalar (`on: push`), flow sequence
// (`on: [push, pull_request]`), flow mapping (`on: { pull_request: {} }`), block mapping or block
// sequence. Expects comment-stripped text.
export function triggersOf(text: string): Set<string> {
  const events = new Set<string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^["']?on["']?:/.test(l));
  if (start < 0) return events;
  const rest = (lines[start] ?? "").replace(/^["']?on["']?:/, "").trim();

  if (rest !== "") {
    let flow = rest;
    for (let i = start + 1; i < lines.length && !balanced(flow); i += 1) {
      flow += ` ${(lines[i] ?? "").trim()}`;
    }
    flowNames(flow).forEach((n) => events.add(n));
    return events;
  }
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const key = /^ {2}["']?([\w-]+)["']?\s*:/.exec(line)?.[1];
    const item = /^ {2}-\s*["']?([\w-]+)["']?\s*$/.exec(line)?.[1];
    if (key) events.add(key);
    if (item) events.add(item);
  }
  return events;
}

function balanced(flow: string): boolean {
  let depth = 0;
  for (const ch of flow) {
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
  }
  return depth <= 0;
}

// Names at the first level of a flow value: `push`, `[a, b]` or `{ a: {...}, b: [..] }`.
function flowNames(flow: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let token = "";
  const flush = (isKey: boolean) => {
    const name = token.trim().replace(/^["']|["']$/g, "");
    if (name && isKey) names.push(name);
    token = "";
  };
  const scalar = !/^[[{]/.test(flow);
  if (scalar) return [flow.replace(/^["']|["']$/g, "")];
  const isMap = flow.startsWith("{");
  for (const ch of flow) {
    if (ch === "[" || ch === "{") {
      depth += 1;
      if (depth > 1) token = "";
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) flush(!isMap);
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ",") flush(!isMap);
    else if (ch === ":" && isMap) flush(true);
    else token += ch;
  }
  // After a `key:` the value text is collected as a token and dropped at the next comma.
  return names.filter((n) => /^[\w-]+$/.test(n));
}

export function runsOnPullRequests(text: string): boolean {
  const events = triggersOf(text);
  return events.has("pull_request") || events.has("pull_request_target");
}

export function usesPullRequestTarget(text: string): boolean {
  return triggersOf(text).has("pull_request_target");
}

// A write grant in any form: `contents: write`, `permissions: write-all`, `permissions: write`
// or an inline mapping such as `permissions: { contents: write }`.
export function hasWritePermission(text: string): boolean {
  return (
    /^\s*permissions:\s*["']?(?:write-all|write)["']?\s*$/m.test(text) ||
    /^\s*permissions:\s*\{[^}]*:\s*["']?write(?:-all)?["']?/m.test(text) ||
    /^\s+[a-z-]+:\s*["']?write["']?\s*$/m.test(text)
  );
}

// `set -x`, `set -ex`, `set -e -x`, `set -euxo pipefail`, `set -o xtrace`, `bash -x`.
export function hasShellTracing(text: string): boolean {
  const joined = joinContinuations(text);
  return (
    /\bset\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*x/.test(joined) ||
    /\bset\s+(?:-[a-zA-Z]+\s+)*-o\s+xtrace\b/.test(joined) ||
    /\bbash\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*x/.test(joined)
  );
}

// `curl -v`, `-sv`, `--verbose`, `--trace`, also when the flag sits on a continuation line.
export function hasVerboseCurl(text: string): boolean {
  return joinContinuations(text)
    .split("\n")
    .some(
      (line) =>
        /\bcurl\b/.test(line) &&
        /(?:\s-[a-zA-Z]*v[a-zA-Z]*(?=\s|$)|--verbose\b|--trace\b)/.test(line),
    );
}

// Handles `environment: production`, `environment: "production"` and the mapping form
// (`environment:` followed by an indented `name: production`).
export function environmentOf(jobText: string): string | undefined {
  const inline = /^ {4}environment:[ \t]+["']?([\w-]+)["']?[ \t]*$/m.exec(jobText);
  if (inline) return inline[1];
  return /^ {4}environment:[ \t]*\n {6}name:[ \t]+["']?([\w-]+)["']?/m.exec(jobText)?.[1];
}

// Jobs of a workflow (comment-stripped here, so raw text works too).
export function jobsOf(text: string): Job[] {
  const body = code(text).split(/^jobs:\n/m)[1] ?? "";
  return body
    .split(/^ {2}(?=[A-Za-z0-9_-]+:\s*$)/m)
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => ({
      name: chunk.split(":")[0] ?? "",
      text: chunk,
      guardedToPush: /^ {4}if:.*github\.event_name == 'push'/m.test(chunk),
    }));
}
