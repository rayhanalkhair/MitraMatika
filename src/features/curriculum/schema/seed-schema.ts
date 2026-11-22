import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "harus berformat YYYY-MM-DD");

export const seedSchema = z.object({
  version: z.object({
    code: z.string().min(1),
    title: z.string().min(1),
    sourceTitle: z.string().min(1),
    sourceUrl: z.url(),
    decreeRef: z.string().min(1).optional(),
    publishedOn: isoDate,
    retrievedOn: isoDate,
  }),
  elements: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        outcomeText: z.string().min(1),
      }),
    )
    .min(1),
  topics: z
    .array(
      z.object({
        stableKey: z
          .string()
          .regex(/^[a-z0-9-]+$/, "hanya huruf kecil, angka, dan tanda hubung"),
        grade: z.union([z.literal(7), z.literal(8), z.literal(9)]),
        elementCode: z.string().min(1),
        title: z.string().min(1),
        scopeNotes: z.string().min(1),
        sourceRef: z.string().min(1),
        sortOrder: z.number().int(),
        objectives: z
          .array(
            z.object({
              code: z.string().min(1),
              text: z.string().min(1),
              sourceRef: z.string().min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type CurriculumSeed = z.infer<typeof seedSchema>;

export type SeedValidation =
  { ok: true; seed: CurriculumSeed } | { ok: false; errors: string[] };

export function validateSeed(input: unknown): SeedValidation {
  const parsed = seedSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const seed = parsed.data;
  const errors: string[] = [];

  const elementCodes = new Set<string>();
  for (const element of seed.elements) {
    if (elementCodes.has(element.code)) {
      errors.push(`Kode elemen ganda: ${element.code}`);
    }
    elementCodes.add(element.code);
  }

  const topicKeys = new Set<string>();
  const objectiveCodes = new Set<string>();
  for (const topic of seed.topics) {
    if (!elementCodes.has(topic.elementCode)) {
      errors.push(
        `Topik ${topic.stableKey} merujuk ke elemen yang tidak ada: ${topic.elementCode}`,
      );
    }
    const key = `${String(topic.grade)}:${topic.stableKey}`;
    if (topicKeys.has(key)) {
      errors.push(
        `stableKey ganda pada kelas ${String(topic.grade)}: ${topic.stableKey}`,
      );
    }
    topicKeys.add(key);
    for (const objective of topic.objectives) {
      if (objectiveCodes.has(objective.code)) {
        errors.push(`Kode tujuan pembelajaran ganda: ${objective.code}`);
      }
      objectiveCodes.add(objective.code);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, seed };
}
