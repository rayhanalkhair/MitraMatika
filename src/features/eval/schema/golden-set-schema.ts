import { z } from "zod";

const difficultySchema = z.enum(["mudah", "sedang", "sulit"]);
const idSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, "hanya huruf kecil, angka, dan tanda hubung");

export const goldenGenerationSpecSchema = z.object({
  id: idSchema,
  grade: z.literal(8),
  topicStableKey: z.string().min(1),
  topicTitle: z.string().min(1),
  difficulty: difficultySchema,
  count: z.number().int().positive(),
  sourceRef: z.string().min(1),
});

export const goldenGenerationSetSchema = z.object({
  version: z.string().min(1),
  items: z.array(goldenGenerationSpecSchema).min(1),
});

const optionLabel = z.enum(["A", "B", "C", "D"]);

// Shaped to match `SolveIndependentParams` (questionStemMd + 4 optionTexts_md)
// plus the ground-truth correctLabel/answer the eval harness scores against —
// not a free-form word problem, since `solve_independent` only ever solves a
// full multiple-choice question (see src/features/generation/service/solve-independent.ts).
const optionsSchema = z
  .array(z.object({ label: optionLabel, text_md: z.string().min(1) }))
  .length(4)
  .refine((options) => new Set(options.map((o) => o.label)).size === 4, {
    message: "Setiap label pilihan (A-D) harus muncul tepat satu kali.",
  });

export const goldenSolverProblemSchema = z.object({
  id: idSchema,
  grade: z.literal(8),
  topicStableKey: z.string().min(1),
  difficulty: difficultySchema,
  stem_md: z.string().min(1),
  options: optionsSchema,
  correctLabel: optionLabel,
  answer: z.object({
    display_md: z.string().min(1),
    machine: z.string().min(1),
  }),
  sourceRef: z.string().min(1),
});

export const goldenSolverSetSchema = z.object({
  version: z.string().min(1),
  items: z.array(goldenSolverProblemSchema).min(1),
});

export const goldenOcrPageSchema = z.object({
  id: idSchema,
  kind: z.enum(["text_pdf", "scan", "phone_photo"]),
  // Path to the source file, local-only (never committed — see data/golden-set/README.md).
  // For "text_pdf", this is the full source PDF and `pageNumber` selects the page,
  // matching how the real product's OCR-on-demand page selection works (MAT-05).
  // For "scan"/"phone_photo", this is a single image file and `pageNumber` is unused.
  path: z.string().min(1),
  pageNumber: z.number().int().positive().optional(),
  expectedText_md: z.string().min(1),
  sourceRef: z.string().min(1),
});

export const goldenOcrSetSchema = z.object({
  version: z.string().min(1),
  items: z.array(goldenOcrPageSchema).min(1),
});

// What actually gets committed to git for the OCR set: the real page images and
// their transcriptions are verbatim excerpts of a copyrighted textbook (unlike the
// generation specs and solver problems, which are original), so per the testing
// strategy's own rule (docs/development/implementation-plan.md §10.2), only an id
// and a content hash are committed — the real content stays in the local-only
// (gitignored) file that goldenOcrSetSchema validates. See data/golden-set/README.md.
export const goldenOcrManifestEntrySchema = z.object({
  id: idSchema,
  kind: z.enum(["text_pdf", "scan", "phone_photo"]),
  pageNumber: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "harus SHA-256 heksadesimal (64 karakter)"),
  sourceRef: z.string().min(1),
});

export const goldenOcrManifestSchema = z.object({
  version: z.string().min(1),
  items: z.array(goldenOcrManifestEntrySchema).min(1),
});

export type GoldenGenerationSpec = z.infer<typeof goldenGenerationSpecSchema>;
export type GoldenGenerationSet = z.infer<typeof goldenGenerationSetSchema>;
export type GoldenSolverProblem = z.infer<typeof goldenSolverProblemSchema>;
export type GoldenSolverSet = z.infer<typeof goldenSolverSetSchema>;
export type GoldenOcrPage = z.infer<typeof goldenOcrPageSchema>;
export type GoldenOcrSet = z.infer<typeof goldenOcrSetSchema>;
export type GoldenOcrManifestEntry = z.infer<typeof goldenOcrManifestEntrySchema>;
export type GoldenOcrManifest = z.infer<typeof goldenOcrManifestSchema>;

type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

export function validateGoldenGenerationSet(
  input: unknown,
): Validation<GoldenGenerationSet> {
  const parsed = goldenGenerationSetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const duplicates = findDuplicateIds(parsed.data.items.map((i) => i.id));
  if (duplicates.length > 0) {
    return { ok: false, errors: duplicates.map((id) => `id ganda: ${id}`) };
  }
  return { ok: true, value: parsed.data };
}

export function validateGoldenSolverSet(input: unknown): Validation<GoldenSolverSet> {
  const parsed = goldenSolverSetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const duplicates = findDuplicateIds(parsed.data.items.map((i) => i.id));
  if (duplicates.length > 0) {
    return { ok: false, errors: duplicates.map((id) => `id ganda: ${id}`) };
  }
  return { ok: true, value: parsed.data };
}

export function validateGoldenOcrSet(input: unknown): Validation<GoldenOcrSet> {
  const parsed = goldenOcrSetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const duplicates = findDuplicateIds(parsed.data.items.map((i) => i.id));
  if (duplicates.length > 0) {
    return { ok: false, errors: duplicates.map((id) => `id ganda: ${id}`) };
  }
  return { ok: true, value: parsed.data };
}

export function validateGoldenOcrManifest(input: unknown): Validation<GoldenOcrManifest> {
  const parsed = goldenOcrManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const duplicates = findDuplicateIds(parsed.data.items.map((i) => i.id));
  if (duplicates.length > 0) {
    return { ok: false, errors: duplicates.map((id) => `id ganda: ${id}`) };
  }
  return { ok: true, value: parsed.data };
}
