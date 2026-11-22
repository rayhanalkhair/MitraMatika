import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

// Relational-query (RQB v2) config for `db.query`. The application queries with the SQL-like
// builder today; these relations describe the ownership spine so relational reads stay typed.
export const relations = defineRelations(schema, (r) => ({
  user: {
    profile: r.one.profiles({ from: r.user.id, to: r.profiles.id }),
    sessions: r.many.session({ from: r.user.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.user.id, to: r.account.userId }),
  },
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id, optional: false }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id, optional: false }),
  },
  profiles: {
    user: r.one.user({ from: r.profiles.id, to: r.user.id, optional: false }),
    jobs: r.many.jobs({ from: r.profiles.id, to: r.jobs.ownerId }),
    questions: r.many.questions({ from: r.profiles.id, to: r.questions.ownerId }),
  },
  jobs: {
    owner: r.one.profiles({ from: r.jobs.ownerId, to: r.profiles.id, optional: false }),
    runs: r.many.jobRuns({ from: r.jobs.id, to: r.jobRuns.jobId }),
  },
  jobRuns: {
    job: r.one.jobs({ from: r.jobRuns.jobId, to: r.jobs.id, optional: false }),
  },
  questions: {
    owner: r.one.profiles({
      from: r.questions.ownerId,
      to: r.profiles.id,
      optional: false,
    }),
    versions: r.many.questionVersions({
      from: r.questions.id,
      to: r.questionVersions.questionId,
    }),
  },
  questionVersions: {
    question: r.one.questions({
      from: r.questionVersions.questionId,
      to: r.questions.id,
      optional: false,
    }),
  },
  schoolTemplates: {
    assessments: r.many.assessments({
      from: r.schoolTemplates.id,
      to: r.assessments.templateId,
    }),
  },
  assessments: {
    template: r.one.schoolTemplates({
      from: r.assessments.templateId,
      to: r.schoolTemplates.id,
    }),
    sections: r.many.assessmentSections({
      from: r.assessments.id,
      to: r.assessmentSections.assessmentId,
    }),
    items: r.many.assessmentItems({
      from: r.assessments.id,
      to: r.assessmentItems.assessmentId,
    }),
    exports: r.many.exports({ from: r.assessments.id, to: r.exports.assessmentId }),
  },
  assessmentSections: {
    assessment: r.one.assessments({
      from: r.assessmentSections.assessmentId,
      to: r.assessments.id,
      optional: false,
    }),
    items: r.many.assessmentItems({
      from: r.assessmentSections.id,
      to: r.assessmentItems.sectionId,
    }),
  },
  assessmentItems: {
    assessment: r.one.assessments({
      from: r.assessmentItems.assessmentId,
      to: r.assessments.id,
      optional: false,
    }),
    section: r.one.assessmentSections({
      from: r.assessmentItems.sectionId,
      to: r.assessmentSections.id,
      optional: false,
    }),
    version: r.one.questionVersions({
      from: r.assessmentItems.questionVersionId,
      to: r.questionVersions.id,
      optional: false,
    }),
  },
  exports: {
    assessment: r.one.assessments({
      from: r.exports.assessmentId,
      to: r.assessments.id,
      optional: false,
    }),
  },
  questionUsages: {
    export: r.one.exports({ from: r.questionUsages.exportId, to: r.exports.id }),
    version: r.one.questionVersions({
      from: r.questionUsages.questionVersionId,
      to: r.questionVersions.id,
      optional: false,
    }),
  },
  folders: {
    parent: r.one.folders({ from: r.folders.parentId, to: r.folders.id }),
    materials: r.many.materials({ from: r.folders.id, to: r.materials.folderId }),
  },
  materials: {
    folder: r.one.folders({ from: r.materials.folderId, to: r.folders.id }),
    sections: r.many.materialSections({
      from: r.materials.id,
      to: r.materialSections.materialId,
    }),
    pages: r.many.materialPages({ from: r.materials.id, to: r.materialPages.materialId }),
  },
  materialSections: {
    material: r.one.materials({
      from: r.materialSections.materialId,
      to: r.materials.id,
      optional: false,
    }),
  },
  materialPages: {
    material: r.one.materials({
      from: r.materialPages.materialId,
      to: r.materials.id,
      optional: false,
    }),
  },
  solverSessions: {
    solutions: r.many.solverSolutions({
      from: r.solverSessions.id,
      to: r.solverSolutions.sessionId,
    }),
  },
  solverSolutions: {
    session: r.one.solverSessions({
      from: r.solverSolutions.sessionId,
      to: r.solverSessions.id,
      optional: false,
    }),
  },
}));
