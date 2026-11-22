import { describe, expect, it } from "vitest";
import { fitMath } from "./fit";

describe("fitMath", () => {
  it("keeps full size when the formula fits", () => {
    expect(fitMath(100, 120)).toEqual({ scale: 1, tooWide: false });
    expect(fitMath(120, 120)).toEqual({ scale: 1, tooWide: false });
  });

  it("steps down to the largest size that fits", () => {
    expect(fitMath(130, 120)).toEqual({ scale: 0.9, tooWide: false });
    expect(fitMath(145, 120)).toEqual({ scale: 0.8, tooWide: false });
    expect(fitMath(165, 120)).toEqual({ scale: 0.7, tooWide: false });
  });

  it("draws at 70 % and reports when even that is too wide", () => {
    expect(fitMath(200, 120)).toEqual({ scale: 0.7, tooWide: true });
  });
});
