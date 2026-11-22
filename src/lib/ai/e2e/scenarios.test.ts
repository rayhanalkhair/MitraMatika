import { describe, expect, it } from "vitest";
import { AiProviderError } from "../types";
import {
  addendsOf,
  E2E_ALTERNATIVE_METHOD,
  E2E_INVENTED_PASSAGE,
  E2E_METHOD,
  E2E_OCR_MARKDOWN,
  E2E_PHOTO_MARKDOWN,
} from "./material-scripts";
import { answerFor, E2E_RATE_LIMIT_MESSAGE } from "./scenarios";

interface Scripted {
  questions: { correctLabel: string; verification_claims: { expected: string }[] }[];
  correctLabel: string;
  answer: { machine: string };
}
const parse = (text: string | Error) => JSON.parse(text as string) as Scripted;

describe("answerFor: valid", () => {
  it("answers generate with the requested number of questions", () => {
    expect(parse(answerFor("valid", "generate", 0, { count: 5 })).questions).toHaveLength(
      5,
    );
    expect(parse(answerFor("valid", "generate", 7, { count: 2 })).questions).toHaveLength(
      2,
    );
  });

  it("answers the solver with the own key and value of the question solved", () => {
    const answer = parse(answerFor("valid", "solver", 0, { n: 3 }));
    expect(answer.correctLabel).toBe("B");
    expect(answer.answer.machine).toBe("6");
    expect(parse(answerFor("valid", "solver", 1, { n: 5 })).answer.machine).toBe("10");
  });

  it("answers a regeneration with one question", () => {
    expect(parse(answerFor("valid", "regenerate", 0)).questions).toHaveLength(1);
  });
});

describe("answerFor: malformed_repairable", () => {
  it("returns non-JSON first, then the batch for the repair call", () => {
    expect(answerFor("malformed_repairable", "generate", 0, { count: 5 })).toBe(
      "not json",
    );
    expect(
      parse(answerFor("malformed_repairable", "generate", 1, { count: 5 })).questions,
    ).toHaveLength(5);
  });

  it("answers the solver and keeps answering valid batches for later calls", () => {
    expect(
      parse(answerFor("malformed_repairable", "solver", 0, { n: 1 })).answer.machine,
    ).toBe("2");
    expect(
      parse(answerFor("malformed_repairable", "generate", 2, { count: 5 })).questions,
    ).toHaveLength(5);
  });
});

describe("answerFor: malformed_twice", () => {
  it("returns non-JSON for the call and its repair", () => {
    expect(answerFor("malformed_twice", "generate", 0, { count: 5 })).toBe("not json");
    expect(answerFor("malformed_twice", "generate", 1, { count: 5 })).toBe("not json");
  });

  it("stays non-JSON for every later call, so a retried job fails the same way", () => {
    for (const index of [2, 3, 10]) {
      expect(answerFor("malformed_twice", "generate", index, { count: 5 })).toBe(
        "not json",
      );
    }
  });
});

describe("answerFor: wrong_key_persistent", () => {
  it("makes question 1's claim contradict its key and keeps the others valid", () => {
    const batch = parse(answerFor("wrong_key_persistent", "generate", 0, { count: 5 }));
    expect(batch.questions).toHaveLength(5);
    expect(batch.questions[0].verification_claims[0].expected).toBe("99");
    expect(batch.questions[0].correctLabel).toBe("B");
    for (const question of batch.questions.slice(1)) {
      expect(question.verification_claims[0].expected).not.toBe("99");
    }
  });

  it("returns a contradicted one-question replacement every time", () => {
    for (const index of [0, 1, 4]) {
      const regenerated = parse(answerFor("wrong_key_persistent", "regenerate", index));
      expect(regenerated.questions).toHaveLength(1);
      expect(regenerated.questions[0].verification_claims[0].expected).toBe("99");
    }
  });

  it("repeats the contradicted batch on a later generate call", () => {
    const batch = parse(answerFor("wrong_key_persistent", "generate", 3, { count: 5 }));
    expect(batch.questions[0].verification_claims[0].expected).toBe("99");
  });

  it("makes the solver agree with the marked key", () => {
    expect(
      parse(answerFor("wrong_key_persistent", "solver", 0, { n: 1 })).correctLabel,
    ).toBe("B");
  });
});

describe("answerFor: rate_limited", () => {
  it("returns a 429 provider error with retry-after for the first generate call", () => {
    const first = answerFor("rate_limited", "generate", 0, { count: 5 });
    expect(first).toBeInstanceOf(AiProviderError);
    const error = first as AiProviderError;
    expect(error.kind).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.message).toBe(E2E_RATE_LIMIT_MESSAGE);
  });

  it("answers like valid afterwards", () => {
    expect(
      parse(answerFor("rate_limited", "generate", 1, { count: 5 })).questions,
    ).toHaveLength(5);
  });
});

describe("answerFor: missing context", () => {
  it("fails loudly when the request did not say how many questions", () => {
    const result = answerFor("valid", "generate", 0);
    expect((result as Error).message).toMatch(
      /scenario=valid task=generate call=0 has no scripted answer/,
    );
  });

  it("fails loudly when the solver prompt did not reveal the question", () => {
    const result = answerFor("valid", "solver", 0);
    expect((result as Error).message).toMatch(
      /scenario=valid task=solver call=0 has no scripted answer/,
    );
  });
});

describe("answerFor: material mode", () => {
  const cited = (text: string | Error) =>
    (
      JSON.parse(text as string) as { questions: { citations: string[] }[] }
    ).questions.map((question) => question.citations);

  it("makes every question cite the offered passages in turn", () => {
    const answer = answerFor("valid", "generate", 0, {
      count: 3,
      passageIds: ["P2", "P3"],
    });
    expect(cited(answer)).toEqual([["P2"], ["P3"], ["P2"]]);
  });

  it("leaves a topic-only batch without citations", () => {
    const answer = parse(answerFor("valid", "generate", 0, { count: 2 }));
    expect(JSON.stringify(answer)).not.toContain("citations");
  });

  it("invents a passage for question 1, in the batch and in its regeneration", () => {
    const batch = answerFor("invented_citation", "generate", 0, {
      count: 2,
      passageIds: ["P2", "P3"],
    });
    expect(cited(batch)).toEqual([[E2E_INVENTED_PASSAGE], ["P3"]]);
    const again = answerFor("invented_citation", "regenerate", 0, {
      passageIds: ["P2", "P3"],
    });
    expect(cited(again)).toEqual([[E2E_INVENTED_PASSAGE]]);
  });

  it("answers like valid for a topic request", () => {
    expect(
      parse(answerFor("invented_citation", "generate", 0, { count: 5 })).questions,
    ).toHaveLength(5);
  });
});

describe("answerFor: materials and solver calls", () => {
  it("reads pages and photos with one uncertain part", () => {
    expect(JSON.parse(answerFor("valid", "ocr_page", 0) as string)).toEqual({
      markdown: E2E_OCR_MARKDOWN,
    });
    expect(JSON.parse(answerFor("rate_limited", "extract_problem", 3) as string)).toEqual(
      { markdown: E2E_PHOTO_MARKDOWN },
    );
    expect(E2E_OCR_MARKDOWN.split("[[?]]")).toHaveLength(3);
    expect(E2E_PHOTO_MARKDOWN.split("[[?]]")).toHaveLength(3);
  });

  it("solves a + b with a claim from the problem's numbers, and agrees in the cross-check", () => {
    const solved = JSON.parse(
      answerFor("valid", "solve_problem", 0, { addends: [17, 25] }) as string,
    ) as {
      method: string;
      final_answer: { value: string };
      verification_claims: { expression: string; expected: string }[];
    };
    expect(solved.method).toBe(E2E_METHOD);
    expect(solved.final_answer.value).toBe("42");
    expect(solved.verification_claims).toEqual([
      { type: "numeric_eval", expression: "17+25", expected: "42" },
    ]);
    const other = JSON.parse(
      answerFor("valid", "alternative_method", 0, { addends: [17, 25] }) as string,
    ) as { method: string; final_answer: { value: string } };
    expect(other.method).toBe(E2E_ALTERNATIVE_METHOD);
    expect(other.final_answer.value).toBe("42");
    expect(
      JSON.parse(
        answerFor("valid", "solve_cross_check", 0, { addends: [17, 25] }) as string,
      ),
    ).toEqual({ answer: "42" });
  });

  it("proposes one chapter over every page", () => {
    const proposal = JSON.parse(
      answerFor("valid", "propose_structure", 0, {
        pageCount: 3,
        topicKey: "8:spldv",
      }) as string,
    ) as { chapters: { pageStart: number; pageEnd: number; topicKey: string | null }[] };
    expect(proposal.chapters).toEqual([
      expect.objectContaining({ pageStart: 1, pageEnd: 3, topicKey: "8:spldv" }),
    ]);
  });

  it("fails loudly without the problem or the page count", () => {
    for (const task of [
      "solve_problem",
      "alternative_method",
      "solve_cross_check",
      "propose_structure",
    ] as const) {
      expect((answerFor("valid", task, 0) as Error).message).toMatch(
        new RegExp(`task=${task} call=0 has no scripted answer`),
      );
    }
  });
});

describe("addendsOf", () => {
  it("finds the first whole-number sum", () => {
    expect(addendsOf("Hitung $12 + 30$.")).toEqual([12, 30]);
    expect(addendsOf("Tidak ada penjumlahan.")).toBeNull();
  });
});
