// Test fixtures for the library, the structure proposal and the material trash: rows written
// straight into the tables (service connection), so each test states exactly what exists.
import { folders, materialPages, materials } from "@/lib/db/schema";
import type { TestDatabase } from "@/lib/db/test-harness";

const SHA = "a".repeat(64);

export interface SeedMaterial {
  ownerId: string;
  title?: string;
  folderId?: string | null;
  grade?: 7 | 8 | 9 | null;
  academicYear?: string | null;
  status?: "uploaded" | "processing" | "needs_review" | "ready" | "failed";
  kind?: "pdf" | "docx" | "image";
  sizeBytes?: number;
  pageCount?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
  purgeAfter?: Date | null;
}

/** One material row (no stored object); returns its id. */
export async function seedMaterial(
  database: TestDatabase,
  input: SeedMaterial,
): Promise<string> {
  const id = crypto.randomUUID();
  const kind = input.kind ?? "pdf";
  const ext = kind === "image" ? "png" : kind;
  await database.db.insert(materials).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId ?? null,
    title: input.title ?? "Buku Matematika",
    kind,
    mime: kind === "pdf" ? "application/pdf" : "application/octet-stream",
    sizeBytes: input.sizeBytes ?? 1000,
    sha256: SHA,
    objectKey: `materials/${input.ownerId}/${id}/source.${ext}`,
    pageCount: input.pageCount === undefined ? 3 : input.pageCount,
    grade: input.grade ?? null,
    academicYear: input.academicYear ?? null,
    status: input.status ?? "ready",
    createdAt: input.createdAt ?? new Date("2026-11-20T01:00:00.000Z"),
    updatedAt: input.updatedAt ?? input.createdAt ?? new Date("2026-11-20T01:00:00.000Z"),
    deletedAt: input.deletedAt ?? null,
    purgeAfter: input.purgeAfter ?? null,
  });
  return id;
}

/** Pages 1..n of a material with the given texts. */
export async function seedPages(
  database: TestDatabase,
  input: { ownerId: string; materialId: string; texts: string[]; from?: number },
): Promise<void> {
  if (input.texts.length === 0) return;
  await database.db.insert(materialPages).values(
    input.texts.map((text, index) => ({
      ownerId: input.ownerId,
      materialId: input.materialId,
      pageNo: (input.from ?? 1) + index,
      textMd: text,
      textSource: "pdf_text",
      confidence: "high",
    })),
  );
}

/** One folder row; returns its id. */
export async function seedFolder(
  database: TestDatabase,
  input: {
    ownerId: string;
    name?: string;
    parentId?: string | null;
    deletedAt?: Date | null;
    purgeAfter?: Date | null;
  },
): Promise<string> {
  const [row] = await database.db
    .insert(folders)
    .values({
      ownerId: input.ownerId,
      name: input.name ?? "Kelas 8",
      parentId: input.parentId ?? null,
      deletedAt: input.deletedAt ?? null,
      purgeAfter: input.purgeAfter ?? null,
    })
    .returning({ id: folders.id });
  return row.id;
}
