import { describe, expect, it } from "vitest";
import { projectCurriculum } from "@/features/review";
import type { QuestionTrace } from "./trace";

const trace = (sourceAnchor: string | null) =>
  ({
    curriculum: {
      versionCode: "v1",
      versionTitle: "Kurikulum",
      element: { code: "GEO", name: "Geometri" },
      topicTitle: "Teorema Pythagoras",
      objectives: [],
      sourceAnchor,
    },
  }) as unknown as QuestionTrace;

describe("projectCurriculum source anchor", () => {
  it("shows only the teacher-facing citation of the seed's source note", () => {
    const anchor =
      "CP Matematika Fase D (BSKAP 046/H/KR/2025), elemen Geometri; disebutkan konsisten pada docs/research/curriculum-sources.md. Kandidat (B22) - menunggu P0-12 dan D-024";
    expect(projectCurriculum(trace(anchor))?.sourceAnchor).toBe(
      "CP Matematika Fase D (BSKAP 046/H/KR/2025), elemen Geometri",
    );
  });

  it("hides an anchor that is purely internal", () => {
    expect(projectCurriculum(trace("lihat docs/x.md"))?.sourceAnchor).toBeNull();
  });
});
