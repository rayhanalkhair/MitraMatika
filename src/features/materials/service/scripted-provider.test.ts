// The e2e fake AI against the materials' real prompts (plan 5, Task 9): OCR and the structure
// proposal land on their own scripted tasks, and the answers pass the same schemas as a real
// model's.
import { afterEach, describe, expect, it } from "vitest";
import { defaultRouting } from "@/lib/ai/routing.config";
import { getE2eAiState, resetE2eAi } from "@/lib/ai/e2e/control";
import { E2E_OCR_MARKDOWN } from "@/lib/ai/e2e/material-scripts";
import { createScriptedProvider } from "@/lib/ai/e2e/scripted-provider";
import { ocrAnswerSchema } from "../schema/ocr";
import { modelProposalSchema } from "../schema/structure";
import { buildOcrPagePrompt } from "./prompts/ocr-page.id";
import { buildStructurePrompt } from "./structure";

afterEach(() => {
  resetE2eAi();
});

async function call(model: string, built: { system: string; prompt: string }) {
  const completion = await createScriptedProvider("groq").complete(
    model,
    built.system,
    built.prompt,
  );
  return JSON.parse(completion.text) as unknown;
}

describe("the e2e scripted provider and the materials prompts", () => {
  it("reads a page image", async () => {
    const answer = ocrAnswerSchema.parse(
      await call(defaultRouting.ocr_page[0].model, buildOcrPagePrompt()),
    );
    expect(answer.markdown).toBe(E2E_OCR_MARKDOWN);
    expect(getE2eAiState().calls.ocr_page).toBe(1);
  });

  it("proposes one chapter over the pages, mapped to the SPLDV topic", async () => {
    const built = buildStructurePrompt({
      title: "Buku",
      pageCount: 3,
      pages: [{ pageNo: 1, textMd: "Sistem persamaan linear dua variabel." }],
      topics: [
        { key: "8:pola-bilangan", title: "Pola Bilangan", grade: 8 },
        {
          key: "8:spldv",
          title: "Sistem Persamaan Linear Dua Variabel (SPLDV)",
          grade: 8,
        },
      ],
    });
    const proposal = modelProposalSchema.parse(
      await call(defaultRouting.propose_structure[0].model, built),
    );
    expect(proposal.chapters).toEqual([
      expect.objectContaining({ pageStart: 1, pageEnd: 3, topicKey: "8:spldv" }),
    ]);
    // Not taken for the generation cross-check that shares the model.
    expect(getE2eAiState().calls).toMatchObject({ propose_structure: 1, solver: 0 });
  });
});
