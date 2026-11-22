// Database fixtures for the export job, request, download and purge tests: an approved assessment
// of banked questions under a school template, and a recording object store.
import { runAsUser } from "@/lib/db/client";
import { schoolTemplates } from "@/lib/db/schema";
import type { TestDatabase } from "@/lib/db/test-harness";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage/types";
import { seedCurriculum } from "@/features/generation";
import {
  addItems,
  addSection,
  approve,
  createAssessment,
  reopen,
  setShuffle,
  type AssessmentDb,
} from "@/features/assessments";
import {
  ASSESSMENT_INPUT,
  seedBankedQuestions,
} from "@/features/assessments/test-support";

export const asUser = <T>(
  database: TestDatabase,
  userId: string,
  fn: (tx: AssessmentDb) => Promise<T>,
) =>
  runAsUser(database.db as unknown as AssessmentDb, userId, (tx) =>
    fn(tx as unknown as AssessmentDb),
  );

export interface SeededAssessment {
  assessmentId: string;
  templateId: string;
  questionIds: string[];
  hash: string;
}

/**
 * An approved assessment of `count` banked questions under a fresh template of the owner, spread
 * over `sections` sections (one by default).
 */
export async function seedApprovedAssessment(
  database: TestDatabase,
  input: { ownerId: string; count?: number; sections?: number; title?: string },
): Promise<SeededAssessment> {
  const { ownerId } = input;
  const curriculum = await seedCurriculum(database.db);
  const questionIds = await seedBankedQuestions(database, {
    ownerId,
    count: input.count ?? 3,
    curriculum,
  });
  const [template] = await database.db
    .insert(schoolTemplates)
    .values({
      ownerId,
      name: "Standar",
      schoolName: "SMP Negeri 1 Contoh",
      headerLines: ["PEMERINTAH KOTA CONTOH"],
      studentFields: ["name", "class"],
    })
    .returning({ id: schoolTemplates.id });
  const created = await asUser(database, ownerId, async (tx) => {
    const result = await createAssessment(tx, {
      ownerId,
      input: {
        ...ASSESSMENT_INPUT,
        title: input.title ?? "Ulangan Bab 1",
        templateId: template.id,
      },
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
  const sectionIds = [created.sectionId];
  for (let n = 1; n < (input.sections ?? 1); n += 1) {
    const added = await asUser(database, ownerId, (tx) =>
      addSection(tx, {
        ownerId,
        assessmentId: created.id,
        title: `Bagian ${String(n + 1)}`,
      }),
    );
    if (!added.ok) throw new Error(added.error);
    sectionIds.push(added.data.id);
  }
  // Even shares; at most 50 questions per call (MAX_ADD_PER_CALL).
  const share = Math.ceil(questionIds.length / sectionIds.length);
  for (const [index, sectionId] of sectionIds.entries()) {
    const own = questionIds.slice(index * share, (index + 1) * share);
    for (let from = 0; from < own.length; from += 50) {
      const added = await asUser(database, ownerId, (tx) =>
        addItems(tx, {
          ownerId,
          assessmentId: created.id,
          sectionId,
          questionIds: own.slice(from, from + 50),
        }),
      );
      if (!added.ok) throw new Error(JSON.stringify(added.error));
    }
  }
  const approved = await asUser(database, ownerId, (tx) =>
    approve(tx, { ownerId, assessmentId: created.id }),
  );
  if (!approved.ok) throw new Error(JSON.stringify(approved.error));
  return {
    assessmentId: created.id,
    templateId: template.id,
    questionIds,
    hash: approved.data.hash,
  };
}

/** Reopens the approved assessment and approves it again unchanged (after a fixture edit). */
export async function reapprove(
  database: TestDatabase,
  input: { ownerId: string; assessmentId: string },
): Promise<string> {
  return asUser(database, input.ownerId, async (tx) => {
    const reopened = await reopen(tx, input);
    if (!reopened.ok) throw new Error(reopened.error);
    const approved = await approve(tx, input);
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    return approved.data.hash;
  });
}

/**
 * Reopens the approved assessment, changes what it prints (the shuffle goes on) and approves it
 * again. Returns the new approval's hash.
 */
export async function reapproveChanged(
  database: TestDatabase,
  input: { ownerId: string; assessmentId: string },
): Promise<string> {
  return asUser(database, input.ownerId, async (tx) => {
    const reopened = await reopen(tx, input);
    if (!reopened.ok) throw new Error(reopened.error);
    const shuffled = await setShuffle(tx, { ...input, mode: "on" });
    if (!shuffled.ok) throw new Error(JSON.stringify(shuffled.error));
    const approved = await approve(tx, input);
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    return approved.data.hash;
  });
}

/** The memory store plus the keys it currently holds (the port itself has no listing). */
export function recordingStore(
  options: { failDeleteOf?: (key: string) => boolean } = {},
): ObjectStore & { keys: () => string[] } {
  const inner = createMemoryStore();
  const keys = new Set<string>();
  return {
    keys: () => [...keys].sort(),
    async put(key, body, contentType) {
      await inner.put(key, body, contentType);
      keys.add(key);
    },
    get: (key) => inner.get(key),
    async delete(key) {
      if (options.failDeleteOf?.(key)) throw new Error("storage unavailable");
      await inner.delete(key);
      keys.delete(key);
    },
    async deletePrefix(prefix) {
      const count = await inner.deletePrefix(prefix);
      for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key);
      return count;
    },
    signedGetUrl: (key, seconds, signed) => inner.signedGetUrl(key, seconds, signed),
    signedPutUrl: (key, type, length, seconds) =>
      inner.signedPutUrl(key, type, length, seconds),
  };
}
