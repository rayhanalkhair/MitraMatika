// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CurriculumChip } from "./CurriculumChip";

afterEach(cleanup);

describe("CurriculumChip", () => {
  it("renders the code once", () => {
    const { container } = render(<CurriculumChip code="TP TP-08-GEO-01" />);
    expect(container.textContent).toBe("TP-08-GEO-01");
  });
});
