import { getDb } from "@/lib/db/runtime";
import { createCurriculumRepository } from "./service/repository";

export * from "./service/repository";

// The repository bound to the runtime database. The catalogue is global and read-only.
export function getCurriculum() {
  return createCurriculumRepository(getDb());
}
export { seedSchema } from "./schema/seed-schema";
export type { CurriculumSeed } from "./schema/seed-schema";
export { loadGrade8SeedV1 } from "./service/load-seed";
export { parsePickerParams } from "./service/picker";
export { writeSeed } from "./service/seed-writer";
export { teacherSourceAnchor } from "./service/teacher-anchor";
