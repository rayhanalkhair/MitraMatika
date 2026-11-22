import { isFakeAiEnabled, resetE2eAi, setScenario } from "@/lib/ai/e2e/control";
import {
  deleteAssessmentData,
  deleteMaterialData,
  deleteSolverData,
  expediteDeferredJobs,
  fillDailyUsage,
  handleControlRequest,
  rewindDailyUsage,
} from "@/lib/ai/e2e/control-route";
import { E2E_FAKE_USER } from "@/features/auth";
import { USER_DAILY_QUESTION_LIMIT } from "@/features/generation";
import {
  INGEST_MATERIAL_JOB,
  OCR_PAGES_JOB,
  PROPOSE_STRUCTURE_JOB,
} from "@/features/materials";
import { SOLVER_JOB_TYPES } from "@/features/solver";
import { getDb } from "@/lib/db/runtime";
import { runDefaultJobs } from "@/lib/jobs/default";
import { getObjectStore } from "@/lib/storage";

// Test-only (E2E_FAKE_AI=1, never in production): 404 otherwise. Not a public path: the proxy
// requires the fake session cookie like any other route.
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleControlRequest(request, {
    enabled: () => isFakeAiEnabled(),
    setScenario,
    resetAi: resetE2eAi,
    expedite: () => expediteDeferredJobs(getDb(), E2E_FAKE_USER.id),
    runJobs: runDefaultJobs,
    resetDailyUsage: () => rewindDailyUsage(getDb(), E2E_FAKE_USER.id),
    fillDailyUsage: () =>
      fillDailyUsage(getDb(), E2E_FAKE_USER.id, USER_DAILY_QUESTION_LIMIT),
    resetAssessments: async () => {
      const counts = await deleteAssessmentData(getDb(), E2E_FAKE_USER.id);
      // The dev server's store (in memory in CI): the fake user's export files and logos.
      const store = getObjectStore();
      await store.deletePrefix(`exports/${E2E_FAKE_USER.id}/`);
      await store.deletePrefix(`templates/${E2E_FAKE_USER.id}/`);
      return counts;
    },
    resetMaterials: async () => {
      const counts = await deleteMaterialData(getDb(), E2E_FAKE_USER.id, [
        INGEST_MATERIAL_JOB,
        OCR_PAGES_JOB,
        PROPOSE_STRUCTURE_JOB,
      ]);
      // The files: stored materials and their page images, and staged uploads.
      const store = getObjectStore();
      await store.deletePrefix(`materials/${E2E_FAKE_USER.id}/`);
      await store.deletePrefix(`uploads/${E2E_FAKE_USER.id}/`);
      return counts;
    },
    resetSolver: async () => {
      const counts = await deleteSolverData(getDb(), E2E_FAKE_USER.id, SOLVER_JOB_TYPES);
      await getObjectStore().deletePrefix(`solver/${E2E_FAKE_USER.id}/`);
      return counts;
    },
  });
}
