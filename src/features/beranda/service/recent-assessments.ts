// The Beranda's recent-assessments tile: one statement, the three most recently changed
// assessments of the teacher (trashed ones left out). The caller applies runAsUser; the statement
// names owner_id as well.
import { and, desc, eq, isNull } from "drizzle-orm";
import { assessments } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";

export const RECENT_ASSESSMENTS = 3;

export interface RecentAssessment {
  id: string;
  title: string;
  status: "draft" | "approved";
  updatedAt: string;
}

export async function getRecentAssessments(
  db: AnyDb,
  input: { ownerId: string },
): Promise<RecentAssessment[]> {
  const rows = await db
    .select({
      id: assessments.id,
      title: assessments.title,
      status: assessments.status,
      updatedAt: assessments.updatedAt,
    })
    .from(assessments)
    .where(and(eq(assessments.ownerId, input.ownerId), isNull(assessments.deletedAt)))
    .orderBy(desc(assessments.updatedAt), desc(assessments.id))
    .limit(RECENT_ASSESSMENTS);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === "approved" ? "approved" : "draft",
    updatedAt: row.updatedAt.toISOString(),
  }));
}
