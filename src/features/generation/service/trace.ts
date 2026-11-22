import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  cpElements,
  curriculumVersions,
  generationRuns,
  learningObjectives,
  materialPages,
  materials,
  questions,
  questionSources,
  questionVersions,
  topics,
  verificationRuns,
} from "@/lib/db/schema";
import type { AnyDb } from "./persist";
import { fromDbStatus, isRegenerationMarker } from "./verification-status";

export interface QuestionTrace {
  questionId: string;
  versionId: string;
  versionNo: number;
  changeKind: string;
  author: string;
  createdAt: Date;
  generation: {
    provider: string;
    model: string;
    promptVersion: string;
    curriculumVersionId: string | null;
    latencyMs: number | null;
    tokens: { input: number | null; output: number | null; cached: number | null };
    ranAt: Date;
  } | null;
  curriculum: {
    versionCode: string;
    versionTitle: string;
    sourceTitle: string;
    decreeRef: string | null;
    topicId: string;
    topicStableKey: string;
    topicTitle: string;
    element: { code: string; name: string };
    objectives: { code: string; text: string }[];
    sourceAnchor: string | null;
  } | null;
  // Material citations (kind `material`). `materialId` is null once the material was deleted for
  // good (MAT-11); the anchor ("hal. <n>") stays. `title` and `pageNo` come from the material
  // while it exists; `live` is false while it sits in the trash.
  materialSources: {
    materialId: string | null;
    title: string | null;
    live: boolean;
    pageNo: number | null;
    anchorLabel: string;
  }[];
  verification: {
    status: string;
    verifierVersion: string | null;
    verifiedAt: Date | null;
    checks: { type: string; status: string; detail: string }[];
    crossCheck: { provider: string; model: string; verdict: string } | null;
    regenerationFailed: boolean;
  };
  versions: { versionNo: number; changeKind: string; status: string }[];
}

const checksSchema = z.array(
  z.object({ type: z.string(), status: z.string(), detail: z.string() }),
);
const crossCheckSchema = z.object({
  provider: z.string(),
  model: z.string(),
  verdict: z.string(),
});

export interface TraceTarget {
  questionId: string;
  versionId: string;
  topicId: string;
}
type Target = TraceTarget;

// Loads everything with a fixed number of set-based statements, whatever the number of targets.
// Every statement names the owner (the function runs under RLS and on the service connection).
// Exported for read models that already know their targets (e.g. the bank list).
export async function buildTraces(
  db: AnyDb,
  ownerId: string,
  targets: TraceTarget[],
): Promise<QuestionTrace[]> {
  return build(db, ownerId, targets);
}

async function build(
  db: AnyDb,
  ownerId: string,
  targets: Target[],
): Promise<QuestionTrace[]> {
  if (targets.length === 0) return [];
  const versionIds = targets.map((target) => target.versionId);
  const questionIds = [...new Set(targets.map((target) => target.questionId))];
  const topicIds = [...new Set(targets.map((target) => target.topicId))];

  const selected = await db
    .select({
      id: questionVersions.id,
      questionId: questionVersions.questionId,
      versionNo: questionVersions.versionNo,
      changeKind: questionVersions.changeKind,
      author: questionVersions.author,
      status: questionVersions.verificationStatus,
      generationRunId: questionVersions.generationRunId,
      createdAt: questionVersions.createdAt,
    })
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.ownerId, ownerId),
        inArray(questionVersions.id, versionIds),
      ),
    );

  const lineage = await db
    .select({
      id: questionVersions.id,
      questionId: questionVersions.questionId,
      versionNo: questionVersions.versionNo,
      changeKind: questionVersions.changeKind,
      status: questionVersions.verificationStatus,
    })
    .from(questionVersions)
    .where(
      and(
        eq(questionVersions.ownerId, ownerId),
        inArray(questionVersions.questionId, questionIds),
      ),
    )
    .orderBy(asc(questionVersions.versionNo));

  const runs =
    lineage.length === 0
      ? []
      : await db
          .select({
            versionId: verificationRuns.questionVersionId,
            status: verificationRuns.status,
            verifierVersion: verificationRuns.verifierVersion,
            checks: verificationRuns.checks,
            crossCheck: verificationRuns.crossCheck,
            createdAt: verificationRuns.createdAt,
          })
          .from(verificationRuns)
          .where(
            and(
              eq(verificationRuns.ownerId, ownerId),
              inArray(
                verificationRuns.questionVersionId,
                lineage.map((row) => row.id),
              ),
            ),
          )
          .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));

  const runIds = [
    ...new Set(
      selected.map((row) => row.generationRunId).filter((id): id is string => !!id),
    ),
  ];
  const generation =
    runIds.length === 0
      ? []
      : await db
          .select()
          .from(generationRuns)
          .where(
            and(eq(generationRuns.ownerId, ownerId), inArray(generationRuns.id, runIds)),
          );

  const sources = await db
    .select({
      versionId: questionSources.questionVersionId,
      kind: questionSources.kind,
      anchorLabel: questionSources.anchorLabel,
      materialId: questionSources.materialId,
      title: materials.title,
      deletedAt: materials.deletedAt,
      pageNo: materialPages.pageNo,
      createdAt: questionSources.createdAt,
      id: questionSources.id,
    })
    .from(questionSources)
    .leftJoin(
      materials,
      and(
        eq(materials.id, questionSources.materialId),
        eq(materials.ownerId, questionSources.ownerId),
      ),
    )
    .leftJoin(
      materialPages,
      and(
        eq(materialPages.id, questionSources.materialPageId),
        eq(materialPages.ownerId, questionSources.ownerId),
      ),
    )
    .where(
      and(
        eq(questionSources.ownerId, ownerId),
        inArray(questionSources.questionVersionId, versionIds),
      ),
    )
    .orderBy(asc(questionSources.createdAt), asc(questionSources.id));

  // The curriculum tables are global and read-only; the topic belongs to exactly one version.
  const topicRows = await db
    .select({
      topicId: topics.id,
      stableKey: topics.stableKey,
      title: topics.title,
      versionCode: curriculumVersions.code,
      versionTitle: curriculumVersions.title,
      sourceTitle: curriculumVersions.sourceTitle,
      decreeRef: curriculumVersions.decreeRef,
      elementCode: cpElements.code,
      elementName: cpElements.name,
    })
    .from(topics)
    .innerJoin(curriculumVersions, eq(curriculumVersions.id, topics.curriculumVersionId))
    .innerJoin(cpElements, eq(cpElements.id, topics.cpElementId))
    .where(inArray(topics.id, topicIds));

  const objectives = await db
    .select({
      topicId: learningObjectives.topicId,
      code: learningObjectives.code,
      text: learningObjectives.text,
    })
    .from(learningObjectives)
    .where(inArray(learningObjectives.topicId, topicIds))
    .orderBy(asc(learningObjectives.code));

  const effective = (versionId: string, columnStatus: string) => {
    const real = runs.filter(
      (run) => run.versionId === versionId && !isRegenerationMarker(run.crossCheck),
    );
    const latest = real.at(-1);
    return { latest, status: fromDbStatus(latest ? latest.status : columnStatus) };
  };

  const traces: QuestionTrace[] = [];
  for (const target of targets) {
    const version = selected.find((row) => row.id === target.versionId);
    if (!version) continue;
    const { latest, status } = effective(version.id, version.status);
    const run = generation.find((row) => row.id === version.generationRunId);
    const topic = topicRows.find((row) => row.topicId === target.topicId);
    const checks = checksSchema.safeParse(latest?.checks);
    const crossCheck = crossCheckSchema.safeParse(latest?.crossCheck);

    traces.push({
      questionId: target.questionId,
      versionId: version.id,
      versionNo: version.versionNo,
      changeKind: version.changeKind,
      author: version.author,
      createdAt: version.createdAt,
      generation: run
        ? {
            provider: run.provider,
            model: run.model,
            promptVersion: run.promptVersion,
            curriculumVersionId: run.curriculumVersionId,
            latencyMs: run.latencyMs,
            tokens: {
              input: run.inputTokens,
              output: run.outputTokens,
              cached: run.cachedTokens,
            },
            ranAt: run.createdAt,
          }
        : null,
      curriculum: topic
        ? {
            versionCode: topic.versionCode,
            versionTitle: topic.versionTitle,
            sourceTitle: topic.sourceTitle,
            decreeRef: topic.decreeRef,
            topicId: topic.topicId,
            topicStableKey: topic.stableKey,
            topicTitle: topic.title,
            element: { code: topic.elementCode, name: topic.elementName },
            objectives: objectives
              .filter((objective) => objective.topicId === target.topicId)
              .map((objective) => ({ code: objective.code, text: objective.text })),
            sourceAnchor:
              sources.find(
                (source) =>
                  source.versionId === version.id && source.kind === "curriculum",
              )?.anchorLabel ?? null,
          }
        : null,
      materialSources: sources
        .filter((source) => source.versionId === version.id && source.kind === "material")
        .map((source) => ({
          materialId: source.materialId,
          title: source.materialId === null ? null : source.title,
          live: source.materialId !== null && source.deletedAt === null,
          pageNo: source.pageNo,
          anchorLabel: source.anchorLabel ?? "",
        })),
      verification: {
        status,
        verifierVersion: latest?.verifierVersion ?? null,
        verifiedAt: latest?.createdAt ?? null,
        checks: checks.success ? checks.data : [],
        crossCheck: crossCheck.success ? crossCheck.data : null,
        regenerationFailed: runs.some(
          (row) => row.versionId === version.id && isRegenerationMarker(row.crossCheck),
        ),
      },
      versions: lineage
        .filter((row) => row.questionId === target.questionId)
        .map((row) => ({
          versionNo: row.versionNo,
          changeKind: row.changeKind,
          status: effective(row.id, row.status).status,
        })),
    });
  }
  return traces;
}

// The provenance of one question version: the current one, or `versionNo` when given. Returns null
// for an unknown question, an unknown version, a question in the trash or one of another owner.
export async function getQuestionTrace(
  db: AnyDb,
  input: { ownerId: string; questionId: string; versionNo?: number },
): Promise<QuestionTrace | null> {
  const question = (
    await db
      .select({
        id: questions.id,
        topicId: questions.topicId,
        currentVersionId: questions.currentVersionId,
      })
      .from(questions)
      .where(
        and(
          eq(questions.id, input.questionId),
          eq(questions.ownerId, input.ownerId),
          isNull(questions.deletedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (!question) return null;

  let versionId = question.currentVersionId;
  if (input.versionNo !== undefined) {
    const version = (
      await db
        .select({ id: questionVersions.id })
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.questionId, question.id),
            eq(questionVersions.ownerId, input.ownerId),
            eq(questionVersions.versionNo, input.versionNo),
          ),
        )
        .limit(1)
    ).at(0);
    versionId = version?.id ?? null;
  }
  if (!versionId) return null;

  const trace = (
    await build(db, input.ownerId, [
      { questionId: question.id, versionId, topicId: question.topicId },
    ])
  ).at(0);
  return trace ?? null;
}

// The current version of every question of one request that is not in the trash, in a stable order (created_at, then id;
// a batch shares created_at, so this is not insertion order).
export async function getRequestTraces(
  db: AnyDb,
  input: { ownerId: string; requestId: string },
): Promise<QuestionTrace[]> {
  const rows = await db
    .select({
      id: questions.id,
      topicId: questions.topicId,
      currentVersionId: questions.currentVersionId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.generationRequestId, input.requestId),
        eq(questions.ownerId, input.ownerId),
        isNull(questions.deletedAt),
      ),
    )
    .orderBy(asc(questions.createdAt), asc(questions.id));
  return build(
    db,
    input.ownerId,
    rows.flatMap((row) =>
      row.currentVersionId === null
        ? []
        : [{ questionId: row.id, versionId: row.currentVersionId, topicId: row.topicId }],
    ),
  );
}
