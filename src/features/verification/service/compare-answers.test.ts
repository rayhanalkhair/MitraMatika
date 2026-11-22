import { describe, expect, it } from "vitest";
import { compareAnswers } from "./compare-answers";

describe("compareAnswers", () => {
  it("matches equal numbers", () => {
    expect(compareAnswers("13", "13")).toBe("match");
  });

  it("matches equivalent notations", () => {
    expect(compareAnswers("0,5", "1/2")).toBe("match");
    expect(compareAnswers("0.5", "50%")).toBe("match");
    expect(compareAnswers("1.000", "1000")).toBe("match");
  });

  it("returns mismatch for different numbers", () => {
    expect(compareAnswers("12", "13")).toBe("mismatch");
    expect(compareAnswers("0,5", "0,6")).toBe("mismatch");
  });

  it("compares text after trimming, collapsing spaces and lower-casing", () => {
    expect(compareAnswers("Segitiga siku-siku", "  segitiga   siku-siku ")).toBe("match");
    expect(compareAnswers("Segitiga siku-siku", "Segitiga sama sisi")).toBe("mismatch");
  });

  it("returns incomparable when only one side is a number", () => {
    expect(compareAnswers("12 cm", "12")).toBe("incomparable");
    expect(compareAnswers("Rp15.000", "15000")).toBe("incomparable");
    expect(compareAnswers("x = 4", "4")).toBe("incomparable");
  });
});
