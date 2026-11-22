// The structure of a material (decision 6 of the materials plan): what the `propose_structure`
// model call must return, what is stored as the proposal, and what the teacher confirms. Every
// field stays editable; nothing the model returns is executed or trusted beyond these shapes.
import { z } from "zod";
import { isAcademicYear } from "./library";

export const PROPOSE_STRUCTURE_JOB = "propose_structure";
/**
 * New proposals one teacher may ask for per Asia/Jakarta day. The model's day budget is shared
 * by every teacher (and by generation's cross-check), so one account must not be able to spend it.
 */
export const USER_DAILY_STRUCTURE_PROPOSALS = 10;
export const MAX_SECTION_TITLE = 200;
export const MAX_CHAPTERS = 60;
const grade = z.union([z.literal(7), z.literal(8), z.literal(9)]);

/**
 * The model's answer. Unknown keys are dropped (zod strips them), lengths and counts are bounded,
 * and a topic is named only by one of the keys the prompt listed (checked by the caller).
 */
export const modelProposalSchema = z.object({
  title: z.string().trim().min(1).max(MAX_SECTION_TITLE),
  grade: grade.nullable(),
  chapters: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(MAX_SECTION_TITLE),
        pageStart: z.number().int().min(1).max(100_000),
        pageEnd: z.number().int().min(1).max(100_000),
        topicKey: z.string().max(120).nullable(),
      }),
    )
    .max(MAX_CHAPTERS),
});
export type ModelProposal = z.infer<typeof modelProposalSchema>;

/** One chapter as stored in `materials.proposed_metadata` and as the editor edits it. */
export const chapterSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_SECTION_TITLE),
    pageStart: z.number().int().min(1),
    pageEnd: z.number().int().min(1),
    topicId: z.uuid().nullable(),
  })
  .refine((chapter) => chapter.pageEnd >= chapter.pageStart, { path: ["pageEnd"] });
export type Chapter = z.infer<typeof chapterSchema>;

/** The stored proposal (validated again when it is read back). */
export const storedProposalSchema = z.object({
  title: z.string().min(1).max(MAX_SECTION_TITLE),
  grade: grade.nullable(),
  chapters: z.array(chapterSchema).max(MAX_CHAPTERS),
  proposedAt: z.string(),
});
export type StoredProposal = z.infer<typeof storedProposalSchema>;

/** What the teacher confirms: the material's metadata and its chapters. */
export const confirmStructureSchema = z.object({
  materialId: z.uuid(),
  title: z.string().trim().min(1).max(MAX_SECTION_TITLE),
  grade: grade.nullable(),
  academicYear: z.string().refine(isAcademicYear).nullable(),
  chapters: z.array(chapterSchema).max(MAX_CHAPTERS),
});
export type ConfirmStructureInput = z.infer<typeof confirmStructureSchema>;

/**
 * Why a confirmation was refused: `notFound` (not the teacher's or trashed), `pages` (a chapter
 * reaches past the last page), `topic` (not a topic of the active curriculum).
 */
export type ConfirmStructureError = "notFound" | "pages" | "topic";
/**
 * Why a proposal could not be asked for: gone, still being read, or the teacher's daily number of
 * proposals is used up (`limit`).
 */
export type RequestStructureError = "notFound" | "notReady" | "limit";

/** What the confirmation carries without the material: the output of `structureFormSchema`. */
export type StructureValues = Omit<ConfirmStructureInput, "materialId">;
const structureValuesSchema = confirmStructureSchema.omit({ materialId: true });

// Every issue of the form schema is the editor's one `invalid` message (its error key).
const typed = { error: "invalid" } as const;
const structureFormFields = z.object(
  {
    title: z.string(typed),
    grade: z.string(typed),
    academicYear: z.string(typed),
    chapters: z.array(
      z.object(
        {
          title: z.string(typed),
          pageStart: z.string(typed),
          pageEnd: z.string(typed),
          topicId: z.string(typed),
        },
        typed,
      ),
      typed,
    ),
  },
  typed,
);

/** A page as typed: whole digits only (a blank, "1.5" or "0x10" is not a page); NaN is refused. */
const pageOf = (text: string) =>
  /^[0-9]+$/.test(text.trim()) ? Number(text) : Number.NaN;

/**
 * The structure form as the teacher fills it, every field a string: a blank grade, academic year
 * or topic is "none". It reads the strings into the confirmation's values and checks them with
 * the same rules the confirmation uses (every issue keeps its path, with the message `invalid`),
 * so the browser and the Server Action refuse the same input.
 */
export const structureFormSchema = structureFormFields.transform(
  (values, ctx): StructureValues => {
    const year = values.academicYear.trim();
    const checked = structureValuesSchema.safeParse({
      title: values.title,
      grade: values.grade.trim() === "" ? null : Number(values.grade),
      academicYear: year === "" ? null : year,
      chapters: values.chapters.map((chapter) => ({
        title: chapter.title,
        pageStart: pageOf(chapter.pageStart),
        pageEnd: pageOf(chapter.pageEnd),
        topicId: chapter.topicId === "" ? null : chapter.topicId,
      })),
    });
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: "custom", message: "invalid", path: issue.path });
      }
      return z.NEVER;
    }
    return checked.data;
  },
);
export type StructureFormValues = z.input<typeof structureFormSchema>;
