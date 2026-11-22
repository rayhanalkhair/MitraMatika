export {
  CAMERA_ACCEPT,
  extensionOf,
  INGEST_MATERIAL_JOB,
  MATERIAL_ACCEPT,
  MATERIAL_TYPES,
  MAX_MATERIAL_BYTES,
  MAX_PDF_PAGES,
  STORAGE_CAP_BYTES,
  titleFromFileName,
} from "./schema/upload";
export type {
  FinalizeUploadError,
  MaterialExt,
  MaterialKind,
  StartUploadError,
  UploadErrorKey,
} from "./schema/upload";
export {
  finalizeUpload,
  isOwnMaterialKey,
  isOwnUploadKey,
  materialSourceKey,
  startUpload,
  uploadStagingKey,
} from "./service/upload";
export type { MaterialDb } from "./service/upload";
export { validateMaterialFile } from "./service/validate";
export {
  createIngestMaterialHandler,
  INGEST_STEP_PAGES,
  type IngestFailureCode,
} from "./service/ingest";
export { registerMaterialHandlers } from "./service/register";
export { pageQuality, type PageQuality } from "./service/page-quality";
export { ommlToLatex } from "./service/omml-to-latex";
export { UploadDropzone } from "./ui/UploadDropzone";
export {
  isAcademicYear,
  MATERIAL_PAGE_SIZE,
  MATERIAL_STATUSES,
  MAX_FOLDER_NAME,
  materialQuerySchema,
} from "./schema/library";
export type {
  FolderError,
  MaterialQuery,
  MaterialStatus,
  MoveMaterialError,
} from "./schema/library";
export {
  confirmStructureSchema,
  PROPOSE_STRUCTURE_JOB,
  storedProposalSchema,
  USER_DAILY_STRUCTURE_PROPOSALS,
} from "./schema/structure";
export type {
  Chapter,
  ConfirmStructureError,
  ConfirmStructureInput,
  RequestStructureError,
  StoredProposal,
} from "./schema/structure";
export {
  countMaterials,
  createFolder,
  getMaterialDetail,
  listFolders,
  listMaterials,
  moveFolder,
  moveMaterial,
  renameFolder,
  storageUsage,
} from "./service/library";
export type {
  FolderItem,
  MaterialDetail,
  MaterialList,
  MaterialListItem,
  MaterialSectionItem,
} from "./service/library";
export {
  buildStructurePrompt,
  confirmStructure,
  createProposeStructureHandler,
  latestStructureJob,
  requestStructureProposal,
} from "./service/structure";
export type { StructureJobStatus } from "./service/structure";
export { sweepMaterials } from "./service/maintenance";
export { handleFinalizeRequest } from "./service/finalize-route";
export type { FinalizeRouteDeps } from "./service/finalize-route";
export {
  MAX_PAGE_IMAGE_BYTES,
  MAX_PAGE_IMAGE_SIDE,
  OCR_PAGES_JOB,
  USER_DAILY_OCR_PAGES,
  USER_DAILY_VISION_READS,
} from "./schema/ocr";
export type { PageUploadError, QueueOcrError, SavePageTextError } from "./schema/ocr";
export {
  createOcrPagesHandler,
  getReviewPage,
  listReviewPages,
  prepareOcrUploads,
  queueOcr,
  savePageText,
} from "./service/ocr";
export type { ReviewPage, ReviewPageSummary } from "./service/ocr";
// The vision model's shared pacing and day budget (the solver's photo reading books its calls the
// same way as OCR pages, under the same model lock).
export {
  OCR_MAX_OUTPUT_TOKENS,
  OCR_QUOTA,
  readVisionSpends,
  teacherVisionPlan,
  VISION_RESERVED,
  VISION_TEACHER_SHARE,
  visionBudget,
} from "./service/ocr";
export {
  lockOcrOwner as lockVisionOwner,
  visionReadsLeft,
  visionReadsToday,
} from "./service/ocr-quota";
export type { VisionSpend } from "./service/ocr";
export { ocrPagesLeft } from "./service/ocr-quota";
export { handleMaterialFileRequest } from "./service/file-route";
export type { MaterialFileDeps } from "./service/file-route";
