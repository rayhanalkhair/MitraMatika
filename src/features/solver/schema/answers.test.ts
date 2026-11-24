import { describe, expect, it } from "vitest";
import { extractionAnswerSchema, solutionAnswerSchema } from "./answers";

describe("solutionAnswerSchema and a literal backslash-n (S-10)", () => {
  it("turns it into a real line break in the steps, as seen in the preview", () => {
    const parsed = solutionAnswerSchema.parse({
      method: "Aljabar",
      steps: [
        {
          title: "Kurangkan 3 dari kedua sisi",
          body_md: String.raw`$$2x + 3 - 3 = 11 - 3$$\n$$2x = 8$$`,
        },
        { body_md: String.raw`Karena $x \neq 0$,\nbagi 2:\n$$x = 4$$` },
      ],
      final_answer: { value: "$x = 4$" },
    });
    expect(parsed.steps[0].body_md).toBe("$$2x + 3 - 3 = 11 - 3$$\n$$2x = 8$$");
    expect(parsed.steps[1].body_md).toBe(
      String.raw`Karena $x \neq 0$,` + "\nbagi 2:\n$$x = 4$$",
    );
  });

  it("normalises the extracted problem text the same way", () => {
    const parsed = extractionAnswerSchema.parse({
      markdown: String.raw`Tentukan x:\n$2x + 3 = 11$ dan $y \neq 0$`,
    });
    expect(parsed.markdown).toBe(
      "Tentukan x:\n$2x + 3 = 11$ dan " + String.raw`$y \neq 0$`,
    );
  });
});
