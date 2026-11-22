// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { CurriculumPanel } from "./CurriculumPanel";

afterEach(cleanup);

describe("CurriculumPanel", () => {
  it("is collapsed by default and lists the element, topic, objectives, source and version", () => {
    const { container } = renderWithIntl(
      <CurriculumPanel
        curriculum={{
          versionCode: "KM-2025",
          versionTitle: "Kurikulum Merdeka 2025",
          elementCode: "aljabar",
          elementName: "Aljabar",
          topicTitle: "SPLDV",
          objectives: [{ code: "TP-3", text: "Tiga" }],
          sourceAnchor: "hlm. 12",
        }}
      />,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    const text = details.textContent;
    for (const part of [
      "Sumber kurikulum",
      "Aljabar",
      "SPLDV",
      "TP-3",
      "Tiga",
      "hlm. 12",
      "KM-2025",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("shows an objective code once even when it already starts with TP", () => {
    const { container } = renderWithIntl(
      <CurriculumPanel
        curriculum={{
          versionCode: "KM-2025",
          versionTitle: "Kurikulum Merdeka 2025",
          elementCode: "geometri",
          elementName: "Geometri",
          topicTitle: "Bangun datar",
          objectives: [{ code: "TP TP-08-GEO-01", text: "Luas" }],
          sourceAnchor: null,
        }}
      />,
    );
    const text = container.textContent;
    expect(text.match(/TP-08-GEO-01/g)).toHaveLength(1);
    expect(text).not.toContain("TP TP-");
  });
});
