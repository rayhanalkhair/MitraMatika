// Test helpers: banked questions of a teacher, and the way an edit or a trash changes them.
import { eq } from "drizzle-orm";
import {
  multipleChoiceQuestionSchema,
  persistDrafts,
  questionJson,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import {
  aiCalls,
  assessments,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
  schoolTemplates,
  topics,
  verificationRuns,
} from "@/lib/db/schema";
import type { TestDatabase } from "@/lib/db/test-harness";

interface Curriculum {
  versionId: string;
  topicId: string;
  sourceRef: string;
}

const NOW = new Date("2026-11-08T10:00:00.000Z");

/** `count` approved and banked questions of the owner, one fixture question each. */
export async function seedBankedQuestions(
  database: TestDatabase,
  input: { ownerId: string; count: number; curriculum: Curriculum; bankedAt?: Date },
): Promise<string[]> {
  const { db } = database;
  const { requestId, jobId } = await seedGenerationRequest(db, {
    ownerId: input.ownerId,
    quantity: input.count,
    ...input.curriculum,
  });
  const saved = await db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId: input.ownerId,
      requestId,
      topicId: input.curriculum.topicId,
      sourceRef: input.curriculum.sourceRef,
      grade: 8,
      difficulty: "sedang",
      run: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@1",
        curriculumVersionId: input.curriculum.versionId,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 5,
      },
      questions: Array.from({ length: input.count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  await db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  for (const id of saved.questionIds) {
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await db
      .update(questions)
      .set({
        status: "approved",
        approvedVersionId: question.currentVersionId,
        approvedAt: NOW,
        bankedAt: input.bankedAt ?? NOW,
      })
      .where(eq(questions.id, id));
  }
  return saved.questionIds;
}

/** Empties every table the assessment tests fill, children first. */
export async function clearAll(database: TestDatabase): Promise<void> {
  const d = database.db;
  await d.delete(assessments);
  await d.delete(schoolTemplates);
  await d.delete(verificationRuns);
  await d.delete(questions);
  await d.delete(generationRuns);
  await d.delete(aiCalls);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
}

export const ASSESSMENT_INPUT = {
  title: "Ulangan",
  kind: "latihan",
  grade: 8,
  templateId: null,
  examDate: null,
  durationMinutes: null,
  instructions: null,
} as const;
