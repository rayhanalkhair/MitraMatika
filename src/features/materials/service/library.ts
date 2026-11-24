import "server-only";
// The materials library (decision 3 of the materials plan): the list with its filters and search,
// the folders (one level of nesting, enforced by the database), moving a material, the storage
// meter and the detail read model. Every function takes the database it is given: the pages and
// actions pass a runAsUser transaction, so RLS applies on top of the owner filter each statement
// names. Trashed materials and folders are never listed, found, edited or used as a target.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  folders,
  materialPages,
  materials,
  materialSections,
  materialUploads,
} from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import {
  folderNameSchema,
  MATERIAL_PAGE_SIZE,
  type FolderError,
  type MaterialQuery,
  type MoveMaterialError,
} from "../schema/library";
import { storedProposalSchema, type StoredProposal } from "../schema/structure";
import { STORAGE_CAP_BYTES } from "../schema/upload";
import { storedBytes, type MaterialDb } from "./upload";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

export interface MaterialListItem {
  id: string;
  title: string;
  kind: string;
  status: string;
  grade: number | null;
  academicYear: string | null;
  pageCount: number | null;
  sizeBytes: number;
  folderId: string | null;
  folderName: string | null;
  /** The teacher confirmed the title, grade and chapters. */
  structureConfirmed: boolean;
  createdAt: string;
  /** With a search: the first page whose text matched (null when only the title did). */
  matchPage: number | null;
}

export interface MaterialList {
  items: MaterialListItem[];
  total: number;
  page: number;
  pageCount: number;
  /** The academic years the owner's materials use, newest first (the year filter's options). */
  years: string[];
}

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  /** Materials directly inside (not trashed). */
  materialCount: number;
}

// Search words are plain text: LIKE wildcards in them are matched literally (backslash escapes),
// and control characters (Postgres refuses NUL) are dropped before anything reaches SQL.
const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");
const cleanSearch = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const live = (ownerId: string) =>
  and(eq(materials.ownerId, ownerId), isNull(materials.deletedAt));

/**
 * A page of the material that matches the search: Indonesian full-text (stemmed, so "persamaan"
 * also finds "menyamakan") or the literal text (the trigram index serves the ILIKE).
 */
function pageMatches(search: string): SQL {
  return sql`${materialPages.materialId} = ${materials.id}
    and ${materialPages.ownerId} = ${materials.ownerId}
    and (${materialPages.tsv} @@ plainto_tsquery('indonesian', ${search})
      or ${materialPages.textMd} ilike ${`%${escapeLike(search)}%`})`;
}

function listFilters(ownerId: string, query: MaterialQuery, search: string): SQL[] {
  const filters: SQL[] = [];
  if (query.folder) filters.push(eq(materials.folderId, query.folder));
  if (query.grade !== undefined) filters.push(eq(materials.grade, query.grade));
  if (query.year) filters.push(eq(materials.academicYear, query.year));
  if (query.status) filters.push(eq(materials.status, query.status));
  if (search) {
    const match = or(
      ilike(materials.title, `%${escapeLike(search)}%`),
      sql`exists (select 1 from ${materialPages} where ${pageMatches(search)} and ${materialPages.ownerId} = ${ownerId})`,
    );
    if (match) filters.push(match);
  }
  return filters;
}

/**
 * The owner's materials, newest first, filtered (folder, grade, academic year, status) and
 * searched over the title and the extracted page text, cut to pages of MATERIAL_PAGE_SIZE. A page
 * past the end shows the last page.
 */
export async function listMaterials(
  db: MaterialDb,
  input: { ownerId: string; query: MaterialQuery },
): Promise<MaterialList> {
  const { ownerId, query } = input;
  const search = query.q ? cleanSearch(query.q) : "";
  const where = and(live(ownerId), ...listFilters(ownerId, query, search));

  const total =
    (await db.select({ n: count() }).from(materials).where(where)).at(0)?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / MATERIAL_PAGE_SIZE));
  const page = Math.min(query.page, pageCount);

  const matchPage = search
    ? sql<
        number | null
      >`(select min(${materialPages.pageNo}) from ${materialPages} where ${pageMatches(search)})`
    : sql<null>`null`;
  const rows = await db
    .select({
      id: materials.id,
      title: materials.title,
      kind: materials.kind,
      status: materials.status,
      grade: materials.grade,
      academicYear: materials.academicYear,
      pageCount: materials.pageCount,
      sizeBytes: materials.sizeBytes,
      folderId: materials.folderId,
      folderName: folders.name,
      metadataConfirmedAt: materials.metadataConfirmedAt,
      createdAt: materials.createdAt,
      matchPage,
    })
    .from(materials)
    .leftJoin(
      folders,
      and(
        eq(folders.id, materials.folderId),
        eq(folders.ownerId, materials.ownerId),
        isNull(folders.deletedAt),
      ),
    )
    .where(where)
    .orderBy(desc(materials.createdAt), asc(materials.id))
    .limit(MATERIAL_PAGE_SIZE)
    .offset((page - 1) * MATERIAL_PAGE_SIZE);

  const years = await db
    .selectDistinct({ year: materials.academicYear })
    .from(materials)
    .where(and(live(ownerId), isNotNull(materials.academicYear)))
    .orderBy(desc(materials.academicYear));

  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      grade: row.grade,
      academicYear: row.academicYear,
      pageCount: row.pageCount,
      sizeBytes: row.sizeBytes,
      folderId: row.folderId,
      folderName: row.folderName,
      structureConfirmed: row.metadataConfirmedAt !== null,
      createdAt: row.createdAt.toISOString(),
      matchPage: row.matchPage,
    })),
    total,
    page,
    pageCount,
    years: years.flatMap((row) => (row.year === null ? [] : [row.year])),
  };
}

/** How many live materials the owner has, whatever the filters (the empty state's question). */
export async function countMaterials(
  db: MaterialDb,
  input: { ownerId: string },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(materials)
    .where(live(input.ownerId));
  return row.n;
}

/** The owner's folders that are not in the trash, by name, with their live material counts. */
export async function listFolders(
  db: MaterialDb,
  input: { ownerId: string },
): Promise<FolderItem[]> {
  const rows = await db
    .select({
      id: folders.id,
      name: folders.name,
      parentId: folders.parentId,
      materialCount: count(materials.id),
    })
    .from(folders)
    .leftJoin(
      materials,
      and(
        eq(materials.folderId, folders.id),
        eq(materials.ownerId, folders.ownerId),
        isNull(materials.deletedAt),
      ),
    )
    .where(and(eq(folders.ownerId, input.ownerId), isNull(folders.deletedAt)))
    .groupBy(folders.id, folders.name, folders.parentId)
    .orderBy(asc(folders.name), asc(folders.id));
  return rows;
}

/**
 * The storage meter: what counts toward the 300 MB cap, exactly as startUpload counts it (every
 * stored material, trashed ones until purged, plus the uploads reserved and not yet expired).
 */
export async function storageUsage(
  db: MaterialDb,
  input: { ownerId: string; now: Date },
): Promise<{ usedBytes: number; capBytes: number }> {
  const stored = await storedBytes(db, input.ownerId);
  const [pending] = await db
    .select({ bytes: sql<string>`coalesce(sum(${materialUploads.sizeBytes}), 0)` })
    .from(materialUploads)
    .where(
      and(
        eq(materialUploads.ownerId, input.ownerId),
        gt(materialUploads.expiresAt, input.now),
      ),
    );
  return {
    usedBytes: stored + Number(pending.bytes),
    capBytes: STORAGE_CAP_BYTES,
  };
}

interface PgFields {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
}

/**
 * The typed refusal behind a failed folder write, or null for anything unexpected (rethrown):
 * a deadlock or serialisation failure (two moves crossed; the database picked this one) is
 * `retry`; the one-level rule (folders_one_level) and the self-parent check are `nesting`.
 */
export function folderFailureOf(error: unknown): FolderError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth += 1) {
    const fields = current as PgFields;
    if (typeof fields.code === "string") {
      const constraint = fields.constraint ?? fields.constraint_name;
      if (["40P01", "40001", "55P03"].includes(fields.code)) return "retry";
      if (fields.code === "23514") {
        if (
          constraint === "folders_one_level" ||
          constraint === "folders_not_own_parent_check"
        ) {
          return "nesting";
        }
        if (constraint === "folders_name_check") return "name";
      }
      return null;
    }
    current = fields.cause;
  }
  return null;
}

/** Runs one folder write in a savepoint, so a refusal leaves the caller's transaction usable. */
async function folderWrite<T>(
  db: MaterialDb,
  write: (tx: MaterialDb) => Promise<Result<T, FolderError>>,
): Promise<Result<T, FolderError>> {
  try {
    return await db.transaction((tx) => write(tx as unknown as MaterialDb));
  } catch (error) {
    const failure = folderFailureOf(error);
    if (failure === null) throw error;
    return err(failure);
  }
}

/**
 * Locks one of the owner's live folders against a concurrent trash (which takes the row FOR
 * UPDATE and then refuses a folder that is not empty). Under runAsUser the update policy hides a
 * trashed folder, so it is not found.
 */
async function lockLiveFolder(db: MaterialDb, ownerId: string, folderId: string) {
  return (
    await db
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.ownerId, ownerId),
          isNull(folders.deletedAt),
        ),
      )
      .for("share")
  ).at(0);
}

/** A new folder at the top level or inside one of the owner's top-level folders. */
export async function createFolder(
  db: MaterialDb,
  input: { ownerId: string; name: string; parentId?: string | null },
): Promise<Result<{ id: string }, FolderError>> {
  const { ownerId } = input;
  const name = folderNameSchema.safeParse(input.name);
  if (!name.success) return err("name");
  const parentId = input.parentId ?? null;
  if (parentId !== null && !isUuid(parentId)) return err("parent");
  return folderWrite(db, async (tx) => {
    if (parentId !== null && !(await lockLiveFolder(tx, ownerId, parentId))) {
      return err("parent");
    }
    // The database refuses a parent that is itself a subfolder (folders_one_level).
    const [row] = await tx
      .insert(folders)
      .values({ ownerId, name: name.data, parentId })
      .returning({ id: folders.id });
    return ok({ id: row.id });
  });
}

export async function renameFolder(
  db: MaterialDb,
  input: { ownerId: string; folderId: string; name: string },
): Promise<Result<void, FolderError>> {
  const { ownerId, folderId } = input;
  const name = folderNameSchema.safeParse(input.name);
  if (!name.success) return err("name");
  if (!isUuid(folderId)) return err("notFound");
  return folderWrite(db, async (tx) => {
    const updated = await tx
      .update(folders)
      .set({ name: name.data, updatedAt: new Date() })
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.ownerId, ownerId),
          isNull(folders.deletedAt),
        ),
      )
      .returning({ id: folders.id });
    return updated.length > 0 ? ok() : err("notFound");
  });
}

/**
 * Moves a folder to the top level (`parentId` null) or into another top-level folder. The
 * database keeps one level of nesting: a target that is a subfolder, or a folder that has
 * subfolders, is `nesting`; two moves that cross may deadlock, and the loser is `retry`.
 */
export async function moveFolder(
  db: MaterialDb,
  input: { ownerId: string; folderId: string; parentId: string | null },
): Promise<Result<void, FolderError>> {
  const { ownerId, folderId, parentId } = input;
  if (!isUuid(folderId)) return err("notFound");
  if (parentId !== null && !isUuid(parentId)) return err("parent");
  const moved = await folderWrite(db, async (tx) => {
    if (parentId !== null && !(await lockLiveFolder(tx, ownerId, parentId))) {
      return err("parent");
    }
    const updated = await tx
      .update(folders)
      .set({ parentId, updatedAt: new Date() })
      .where(
        and(
          eq(folders.id, folderId),
          eq(folders.ownerId, ownerId),
          isNull(folders.deletedAt),
        ),
      )
      .returning({ id: folders.id });
    return updated.length > 0 ? ok() : err("notFound");
  });
  if (moved.ok || moved.error !== "nesting" || parentId === null) return moved;
  // The database counts subfolders in the trash too; when only those are in the way, say so
  // (the teacher sees no subfolder in the list).
  const children = await db
    .select({ deletedAt: folders.deletedAt })
    .from(folders)
    .where(and(eq(folders.ownerId, ownerId), eq(folders.parentId, folderId)));
  return children.length > 0 && children.every((child) => child.deletedAt !== null)
    ? err("trashedSubfolders")
    : moved;
}

/** Moves one of the owner's live materials into a live folder of theirs, or to the top level. */
export async function moveMaterial(
  db: MaterialDb,
  input: { ownerId: string; materialId: string; folderId: string | null },
): Promise<Result<void, MoveMaterialError>> {
  const { ownerId, materialId, folderId } = input;
  if (!isUuid(materialId)) return err("notFound");
  if (folderId !== null && !isUuid(folderId)) return err("folder");
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as MaterialDb;
    if (folderId !== null && !(await lockLiveFolder(tx, ownerId, folderId))) {
      return err<MoveMaterialError>("folder");
    }
    const updated = await tx
      .update(materials)
      .set({ folderId, updatedAt: new Date() })
      .where(and(eq(materials.id, materialId), live(ownerId)))
      .returning({ id: materials.id });
    return updated.length > 0 ? ok() : err<MoveMaterialError>("notFound");
  });
}

export interface MaterialSectionItem {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number | null;
  topicId: string | null;
}

export interface MaterialDetail {
  id: string;
  title: string;
  kind: string;
  mime: string;
  status: string;
  sizeBytes: number;
  pageCount: number | null;
  grade: number | null;
  academicYear: string | null;
  folderId: string | null;
  folderName: string | null;
  createdAt: string;
  metadataConfirmedAt: string | null;
  /** Stored pages by confidence (decision 4). */
  pages: { total: number; high: number; medium: number; low: number };
  /** Page numbers whose text is not rated high (to review, or to OCR in Task 6). */
  flaggedPages: number[];
  /** The distinct reasons behind those pages (page flags), in a fixed order. */
  flagReasons: string[];
  /** Bytes of the stored page pictures (OCR), counted in the storage meter next to the file. */
  pageImageBytes: number;
  /** The model's proposal, when one was made and still reads as valid. */
  proposal: StoredProposal | null;
  /** The confirmed chapters. */
  sections: MaterialSectionItem[];
}

/** The order the reasons of a flagged page are listed in (the OCR review lists them the same way). */
const FLAG_ORDER = ["low_text", "garbled", "formula_text", "uncertain_math", "truncated"];

/** One of the owner's live materials for its detail page, or null (unknown, foreign, trashed). */
export async function getMaterialDetail(
  db: MaterialDb,
  input: { ownerId: string; materialId: string },
): Promise<MaterialDetail | null> {
  const { ownerId, materialId } = input;
  if (!isUuid(materialId)) return null;
  const row = (
    await db
      .select({
        id: materials.id,
        title: materials.title,
        kind: materials.kind,
        mime: materials.mime,
        status: materials.status,
        sizeBytes: materials.sizeBytes,
        pageCount: materials.pageCount,
        grade: materials.grade,
        academicYear: materials.academicYear,
        folderId: materials.folderId,
        folderName: folders.name,
        createdAt: materials.createdAt,
        metadataConfirmedAt: materials.metadataConfirmedAt,
        proposedMetadata: materials.proposedMetadata,
      })
      .from(materials)
      .leftJoin(
        folders,
        and(
          eq(folders.id, materials.folderId),
          eq(folders.ownerId, materials.ownerId),
          isNull(folders.deletedAt),
        ),
      )
      .where(and(eq(materials.id, materialId), live(ownerId)))
      .limit(1)
  ).at(0);
  if (!row) return null;

  const ofMaterial = and(
    eq(materialPages.materialId, materialId),
    eq(materialPages.ownerId, ownerId),
  );
  const byConfidence = await db
    .select({ confidence: materialPages.confidence, n: count() })
    .from(materialPages)
    .where(ofMaterial)
    .groupBy(materialPages.confidence);
  const pages = { total: 0, high: 0, medium: 0, low: 0 };
  for (const group of byConfidence) {
    const n = group.n;
    pages.total += n;
    if (group.confidence === "high" || group.confidence === "medium") {
      pages[group.confidence] += n;
    } else pages.low += n;
  }
  const flagged = await db
    .select({ pageNo: materialPages.pageNo, flags: materialPages.flags })
    .from(materialPages)
    .where(and(ofMaterial, ne(materialPages.confidence, "high")))
    .orderBy(asc(materialPages.pageNo));
  const reasons = new Set(
    flagged.flatMap((page) =>
      Array.isArray(page.flags)
        ? page.flags.filter((flag): flag is string => typeof flag === "string")
        : [],
    ),
  );
  const [images] = await db
    .select({ bytes: sql<string>`coalesce(sum(${materialPages.imageBytes}), 0)` })
    .from(materialPages)
    .where(ofMaterial);
  const sections = await db
    .select({
      id: materialSections.id,
      title: materialSections.title,
      pageStart: materialSections.pageStart,
      pageEnd: materialSections.pageEnd,
      topicId: materialSections.topicId,
    })
    .from(materialSections)
    .where(
      and(
        eq(materialSections.materialId, materialId),
        eq(materialSections.ownerId, ownerId),
      ),
    )
    .orderBy(asc(materialSections.pageStart), asc(materialSections.id));
  const proposal = storedProposalSchema.safeParse(row.proposedMetadata);

  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    mime: row.mime,
    status: row.status,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    grade: row.grade,
    academicYear: row.academicYear,
    folderId: row.folderId,
    folderName: row.folderName,
    createdAt: row.createdAt.toISOString(),
    metadataConfirmedAt: row.metadataConfirmedAt?.toISOString() ?? null,
    pages,
    flaggedPages: flagged.map((page) => page.pageNo),
    flagReasons: FLAG_ORDER.filter((flag) => reasons.has(flag)),
    pageImageBytes: Number(images.bytes),
    proposal: proposal.success ? proposal.data : null,
    sections,
  };
}
