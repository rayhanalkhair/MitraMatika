// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { Calculator } from "lucide-react";
import { ComingSoon } from "./ComingSoon";

afterEach(cleanup);

describe("ComingSoon", () => {
  it("renders the title, a one-paragraph description of what is planned and no fake data", () => {
    const { container } = renderWithIntl(
      <ComingSoon
        title="Selesaikan"
        description="Menyelesaikan soal langkah demi langkah."
        icon={Calculator}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Selesaikan" })).toBeTruthy();
    expect(screen.getByText("Segera hadir")).toBeTruthy();
    expect(screen.getByText("Menyelesaikan soal langkah demi langkah.")).toBeTruthy();
    // Text only: no lists, tables, images or buttons that could carry sample data.
    expect(container.querySelectorAll("ul, ol, table, img, button, a")).toHaveLength(0);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});
