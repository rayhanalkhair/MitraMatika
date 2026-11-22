import { generateMultipleChoiceBatch } from "@/features/generation";
import { requireGroqApiKey } from "../env";
import { TokenBudget } from "./budget";
import { createGateway } from "./gateway";
import { defaultRouting } from "./routing.config";
import { JsonlAiCallLog } from "./logging";
import { createGroqProvider } from "./providers/groq";

async function main() {
  let apiKey: string;
  try {
    apiKey = requireGroqApiKey();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const logger = new JsonlAiCallLog(".data/ai-calls.jsonl");
  const groq = createGroqProvider({ apiKey, logger });
  const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
  const gateway = createGateway({ routing: defaultRouting, providers: { groq }, budget });

  console.log("Mengirim satu permintaan uji ke Groq...");
  const result = await generateMultipleChoiceBatch(gateway, {
    grade: 8,
    topicTitle: "Operasi bilangan bulat",
    topicScopeNotes: "Penjumlahan dan pengurangan bilangan bulat sederhana.",
    difficulty: "mudah",
    count: 1,
    dataClass: "C0",
  });

  console.log(`Berhasil. Provider: ${result.provider}, model: ${result.model}`);
  console.log(JSON.stringify(result.value, null, 2));
  console.log("Log panggilan ditambahkan ke .data/ai-calls.jsonl");
}

main().catch((error: unknown) => {
  console.error("Uji coba gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
