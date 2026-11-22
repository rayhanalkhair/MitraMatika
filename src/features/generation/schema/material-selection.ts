import { z } from "zod";

// What a material-mode request may draw on: the whole document, some chapters (confirmed
// sections) or a list of pages. Stored as generation_requests.source_selection.
export const MATERIAL_SCOPES = ["all", "sections", "pages"] as const;
export type MaterialScope = (typeof MATERIAL_SCOPES)[number];

export const MAX_SELECTED_SECTIONS = 60;
export const MAX_SELECTED_PAGES = 300;

export const materialSelectionSchema = z.discriminatedUnion("scope", [
  z.object({ materialId: z.guid(), scope: z.literal("all") }),
  z.object({
    materialId: z.guid(),
    scope: z.literal("sections"),
    sectionIds: z.array(z.guid()).min(1).max(MAX_SELECTED_SECTIONS),
  }),
  z.object({
    materialId: z.guid(),
    scope: z.literal("pages"),
    pages: z.array(z.number().int().min(1).max(300)).min(1).max(MAX_SELECTED_PAGES),
  }),
]);

export type MaterialSelection = z.infer<typeof materialSelectionSchema>;

/**
 * The teacher's page list ("1-3, 5"): page numbers and ranges separated by commas or spaces.
 * Returns the pages in order without duplicates, or null for anything else (a reversed or
 * oversized range, a page 0, letters).
 */
export function parsePageList(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const pages = new Set<number>();
  for (const part of parts) {
    const match = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    // An unmatched group is undefined at run time (the type says string).
    const end = match[2] as string | undefined;
    const to = end ? Number(end) : from;
    if (from < 1 || to < from || to > 300) return null;
    for (let page = from; page <= to; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
