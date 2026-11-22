import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAiCallLog, NullAiCallLog, type AiCallRecord } from "./logging";

const sample: AiCallRecord = {
  at: "2026-09-22T00:00:00.000Z",
  provider: "groq",
  model: "openai/gpt-oss-120b",
  latencyMs: 42,
  outcome: "ok",
  promptTokens: 10,
  completionTokens: 20,
  totalTokens: 30,
};

describe("NullAiCallLog", () => {
  it("resolves without writing anything observable", async () => {
    await expect(new NullAiCallLog().record(sample)).resolves.toBeUndefined();
  });
});

describe("JsonlAiCallLog", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mitramatika-ai-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the parent directory and appends one JSON line per record", async () => {
    const filePath = join(dir, "nested", "ai-calls.jsonl");
    const log = new JsonlAiCallLog(filePath);
    await log.record(sample);
    await log.record({ ...sample, outcome: "error", errorMessage: "boom" });

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(sample);
    expect((JSON.parse(lines[1]) as { errorMessage: string }).errorMessage).toBe("boom");
  });
});
