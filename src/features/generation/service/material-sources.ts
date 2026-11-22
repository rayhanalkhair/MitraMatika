import { z } from "zod";
import { questionSources } from "@/lib/db/schema";
import type { Citation } from "./citations";
import type { MaterialPassage } from "./material-context";
import type { AnyDb } from "./persist";

/** One `question_sources` row of kind `material` (ruling R8: page and section of that material). */
export interface MaterialSourceRow {
  // Null only for a version written after the material was deleted ("Materi sumber telah
  // dihapus"): it cites no page.
  materialId: string | null;
  materialPageId: string | null;
  sectionId: string | null;
  // "hal. <n>": kept when the material is deleted for good (MAT-11).
  anchorLabel: string;
  // At most 300 characters of the page text, no markers (null without a material).
  excerpt: string | null;
}

// The source row of a teacher's regeneration made after the question's material was deleted
// or trashed: no page, shown as "Materi sumber telah dihapus".
export const DELETED_MATERIAL_ANCHOR = "materi dihapus";
export const DELETED_MATERIAL_SOURCE: MaterialSourceRow = {
  materialId: null,
  materialPageId: null,
  sectionId: null,
  anchorLabel: DELETED_MATERIAL_ANCHOR,
  excerpt: null,
};

/** The material a request draws on and the passages its prompt carried. */
export interface MaterialPack {
  materialId: string;
  passages: MaterialPassage[];
}

/** The rows for valid citations: each cited passage's page, section and excerpt. */
export function citationSources(
  pack: MaterialPack,
  citations: Citation[],
): MaterialSourceRow[] {
  return citations.flatMap((citation) => {
    const passage = pack.passages.find(
      (candidate) => candidate.id === citation.passageId,
    );
    return passage
      ? [
          {
            materialId: pack.materialId,
            materialPageId: passage.pageId,
            sectionId: passage.sectionId,
            anchorLabel: `hal. ${String(passage.page)}`,
            excerpt: passage.excerpt,
          },
        ]
      : [];
  });
}

/** Writes the material citations of one version (service connection, explicit owner, R9). */
export async function insertMaterialSources(
  db: AnyDb,
  input: { ownerId: string; versionId: string; rows: MaterialSourceRow[]; now: Date },
): Promise<void> {
  if (input.rows.length === 0) return;
  await db.insert(questionSources).values(
    input.rows.map((row) => ({
      ownerId: input.ownerId,
      questionVersionId: input.versionId,
      kind: "material",
      materialId: row.materialId,
      materialPageId: row.materialPageId,
      sectionId: row.sectionId,
      anchorLabel: row.anchorLabel,
      excerpt: row.excerpt,
      createdAt: input.now,
    })),
  );
}

// The check a verification run carries for a question whose citations were rejected.
export const CITATION_CHECK_TYPE = "citation";
// Shown to the teacher in the verification sheet and, as the correction note, to the model when
// the question is regenerated.
export const CITATION_FAILURE_DETAIL =
  "Kutipan bagian materi tidak dikenal. Gunakan hanya id bagian materi yang diberikan.";

// A material question written after its material was deleted cites nothing: not verified as
// cited (ruling: the same unverifiable status as rejected citations, with its own reason).
export const MATERIAL_GONE_CHECK = {
  type: CITATION_CHECK_TYPE,
  status: "fail",
  detail: "Materi sumber telah dihapus, jadi soal ini tidak mengutip halaman materi.",
} as const;

/** The failed check a verification run carries for a version whose citations were rejected. */
export const CITATION_FAILURE_CHECK = {
  type: CITATION_CHECK_TYPE,
  status: "fail",
  detail: CITATION_FAILURE_DETAIL,
} as const;

const checksSchema = z.array(z.object({ type: z.string(), status: z.string() }));

/** True for a run that recorded rejected citations. */
export function hasCitationFailure(run: { checks: unknown } | null): boolean {
  if (run === null) return false;
  const parsed = checksSchema.safeParse(run.checks);
  return (
    parsed.success &&
    parsed.data.some(
      (check) => check.type === CITATION_CHECK_TYPE && check.status === "fail",
    )
  );
}
