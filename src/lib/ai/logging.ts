import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AiCallOutcome = "ok" | "error";

export interface AiCallRecord {
  at: string;
  provider: string;
  model: string;
  latencyMs: number;
  outcome: AiCallOutcome;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  errorMessage?: string;
}

export interface AiCallLogger {
  record(entry: AiCallRecord): Promise<void>;
}

export class NullAiCallLog implements AiCallLogger {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async record(_entry: AiCallRecord): Promise<void> {
    // Intentionally does nothing.
  }
}

export class JsonlAiCallLog implements AiCallLogger {
  constructor(private readonly filePath: string) {}

  async record(entry: AiCallRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
