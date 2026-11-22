import { describe, expect, it } from "vitest";
import { verifyClaims } from "./verify";

describe("verifyClaims", () => {
  it("is belum_dapat_diverifikasi with no claims", () => {
    expect(verifyClaims([]).status).toBe("belum_dapat_diverifikasi");
  });

  it("is terverifikasi when all evaluable claims pass", () => {
    const { status, results } = verifyClaims([
      { type: "numeric_eval", expression: "3^2 + 4^2", expected: "25" },
      {
        type: "choice_matches_answer",
        options: ["24", "25", "26", "27"],
        markedIndex: 1,
        answer: "25",
      },
    ]);
    expect(status).toBe("terverifikasi");
    expect(results).toHaveLength(2);
  });

  it("is ketidaksesuaian when any claim fails", () => {
    const { status } = verifyClaims([
      { type: "numeric_eval", expression: "3^2 + 4^2", expected: "25" },
      {
        type: "choice_matches_answer",
        options: ["24", "25", "26", "27"],
        markedIndex: 0,
        answer: "25",
      },
    ]);
    expect(status).toBe("ketidaksesuaian");
  });

  it("is belum_dapat_diverifikasi when every claim is unsupported", () => {
    const { status } = verifyClaims([
      { type: "numeric_eval", expression: "3 +* 4", expected: "7" },
    ]);
    expect(status).toBe("belum_dapat_diverifikasi");
  });

  it("stays terverifikasi when an unsupported claim sits beside a passing one", () => {
    const { status } = verifyClaims([
      { type: "numeric_eval", expression: "2 + 2", expected: "4" },
      { type: "numeric_eval", expression: "3 +* 4", expected: "7" },
    ]);
    expect(status).toBe("terverifikasi");
  });
});
