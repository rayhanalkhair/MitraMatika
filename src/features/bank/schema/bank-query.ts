import { z } from "zod";

export const BANK_PAGE_SIZE = 20;
export const BANK_SORTS = ["newest", "oldest", "difficulty"] as const;
export const BANK_STATUSES = [
  "terverifikasi",
  "dicek_silang",
  "belum_dapat_diverifikasi",
  "ketidaksesuaian",
] as const;

// URL params come as a string, or an array when repeated: only the first counts. A param that
// does not parse is dropped (the default applies); the page never errors on a bad link.
const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
const param = <T extends z.ZodType>(schema: T) =>
  z.preprocess(first, schema.optional().catch(undefined));

// A real calendar date, not just the right shape: "2026-02-31" or "2026-99-99" is dropped.
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });

export const bankQuerySchema = z.object({
  grade: param(
    z.coerce.number().pipe(z.union([z.literal(7), z.literal(8), z.literal(9)])),
  ),
  topicId: param(z.uuid()),
  elementId: param(z.uuid()),
  difficulty: param(z.enum(["mudah", "sedang", "sulit"])),
  type: param(z.enum(["multiple_choice"])),
  status: param(z.enum(BANK_STATUSES)),
  origin: param(z.enum(["generated", "manual", "imported"])),
  from: param(day),
  to: param(day),
  // Longer than 100 characters is cut, not dropped.
  q: param(
    z
      .string()
      .transform((value) => value.trim().slice(0, 100).trim())
      .pipe(z.string().min(1)),
  ),
  sort: z.preprocess(first, z.enum(BANK_SORTS).catch("newest")),
  page: z.preprocess(first, z.coerce.number().int().min(1).catch(1)),
});

export type BankQuery = z.infer<typeof bankQuerySchema>;
