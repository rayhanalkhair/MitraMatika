import { sql } from "drizzle-orm";
import type { TestDatabase } from "./test-harness";
import { USER_A, USER_B } from "./test-harness";

// Deterministic, valid UUIDs: owner 0 = global rows, 1 = user A, 2 = user B.
export const fid = (owner: 0 | 1 | 2, n: number) =>
  `${String(owner)}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const FIXTURE = {
  curriculumVersion: fid(0, 1),
  element: fid(0, 2),
  topic: fid(0, 3),
  objective: fid(0, 4),
  job: (o: 1 | 2) => fid(o, 10),
  request: (o: 1 | 2) => fid(o, 11),
  run: (o: 1 | 2) => fid(o, 12),
  question: (o: 1 | 2) => fid(o, 13),
  version: (o: 1 | 2) => fid(o, 14),
  source: (o: 1 | 2) => fid(o, 15),
  verification: (o: 1 | 2) => fid(o, 16),
  aiCall: (o: 1 | 2) => fid(o, 17),
  audit: (o: 1 | 2) => fid(o, 18),
  usage: (o: 1 | 2) => fid(o, 19),
  appError: (o: 1 | 2) => fid(o, 20),
  jobRun: (o: 1 | 2) => fid(o, 21),
  session: (o: 1 | 2) => fid(o, 22),
  account: (o: 1 | 2) => fid(o, 23),
  deletion: (o: 1 | 2) => fid(o, 24),
  template: (o: 1 | 2) => fid(o, 25),
  assessment: (o: 1 | 2) => fid(o, 26),
  section: (o: 1 | 2) => fid(o, 27),
  item: (o: 1 | 2) => fid(o, 28),
  export: (o: 1 | 2) => fid(o, 29),
  questionUsage: (o: 1 | 2) => fid(o, 30),
  folder: (o: 1 | 2) => fid(o, 31),
  material: (o: 1 | 2) => fid(o, 32),
  materialSection: (o: 1 | 2) => fid(o, 33),
  materialPage: (o: 1 | 2) => fid(o, 34),
  ocrUsage: (o: 1 | 2) => fid(o, 35),
  solverSession: (o: 1 | 2) => fid(o, 36),
  solverSolution: (o: 1 | 2) => fid(o, 37),
  materialUpload: (o: 1 | 2) => fid(o, 38),
};

const run = (db: TestDatabase["db"], statement: string) => db.execute(sql.raw(statement));

// Seeds through the owner connection (which bypasses RLS) so tests start from a known state.
export async function seedFixtures(db: TestDatabase["db"]): Promise<void> {
  await run(
    db,
    `insert into curriculum_versions (id, code, title, source_title, source_url, published_on, retrieved_on, status)
     values ('${FIXTURE.curriculumVersion}', 'v1', 'CP', 'Sumber', 'https://example.test', '2025-01-01', '2026-09-01', 'active')`,
  );
  await run(
    db,
    `insert into cp_elements (id, curriculum_version_id, code, name, outcome_text)
     values ('${FIXTURE.element}', '${FIXTURE.curriculumVersion}', 'aljabar', 'Aljabar', 'Capaian')`,
  );
  await run(
    db,
    `insert into topics (id, curriculum_version_id, cp_element_id, grade, stable_key, title, scope_notes, source_ref, sort_order)
     values ('${FIXTURE.topic}', '${FIXTURE.curriculumVersion}', '${FIXTURE.element}', 8, 'pola', 'Pola', 'Cakupan', 'ref', 1)`,
  );
  await run(
    db,
    `insert into learning_objectives (id, topic_id, code, text, source_ref)
     values ('${FIXTURE.objective}', '${FIXTURE.topic}', 'TP-1', 'Tujuan', 'ref')`,
  );

  for (const [o, user] of [
    [1, USER_A],
    [2, USER_B],
  ] as const) {
    await run(
      db,
      `insert into jobs (id, owner_id, type) values ('${FIXTURE.job(o)}', '${user}', 'generate_batch')`,
    );
    await run(
      db,
      `insert into job_runs (id, job_id, owner_id, outcome) values ('${FIXTURE.jobRun(o)}', '${FIXTURE.job(o)}', '${user}', 'succeeded')`,
    );
    await run(
      db,
      `insert into session (id, user_id, token, expires_at, updated_at)
       values ('${FIXTURE.session(o)}', '${user}', 'token-${String(o)}', now() + interval '1 day', now())`,
    );
    await run(
      db,
      `insert into account (id, user_id, account_id, provider_id, updated_at)
       values ('${FIXTURE.account(o)}', '${user}', 'acct-${String(o)}', 'google', now())`,
    );
    await run(
      db,
      `insert into generation_requests (id, owner_id, job_id) values ('${FIXTURE.request(o)}', '${user}', '${FIXTURE.job(o)}')`,
    );
    await run(
      db,
      `insert into generation_runs (id, owner_id, request_id, task, provider, model, prompt_version, outcome)
       values ('${FIXTURE.run(o)}', '${user}', '${FIXTURE.request(o)}', 'generate_questions', 'fake', 'fake-1', 'v1', 'ok')`,
    );
    await run(
      db,
      `insert into questions (id, owner_id, grade, difficulty, topic_id, generation_request_id)
       values ('${FIXTURE.question(o)}', '${user}', 8, 'sedang', '${FIXTURE.topic}', '${FIXTURE.request(o)}')`,
    );
    await run(
      db,
      `insert into question_versions (id, owner_id, question_id, version_no, author, change_kind, difficulty, stem_md, options, answer, explanation_md, steps, verification_claims, verification_status, generation_run_id)
       values ('${FIXTURE.version(o)}', '${user}', '${FIXTURE.question(o)}', 1, 'ai', 'generated', 'sedang', 'Berapa 2 + 3?', '[]', '{}', 'Jawab', '[]', '[]', 'belum_dapat_diverifikasi', '${FIXTURE.run(o)}')`,
    );
    await run(
      db,
      `update questions set current_version_id = '${FIXTURE.version(o)}' where id = '${FIXTURE.question(o)}'`,
    );
    await run(
      db,
      `insert into question_sources (id, owner_id, question_version_id, topic_id)
       values ('${FIXTURE.source(o)}', '${user}', '${FIXTURE.version(o)}', '${FIXTURE.topic}')`,
    );
    await run(
      db,
      `insert into verification_runs (id, owner_id, question_version_id, verifier_version, status)
       values ('${FIXTURE.verification(o)}', '${user}', '${FIXTURE.version(o)}', 'v1', 'belum_dapat_diverifikasi')`,
    );
    await run(
      db,
      `insert into ai_calls (id, owner_id, job_id, task, provider, model, prompt_version, outcome)
       values ('${FIXTURE.aiCall(o)}', '${user}', '${FIXTURE.job(o)}', 'generate_questions', 'fake', 'fake-1', 'v1', 'ok')`,
    );
    await run(
      db,
      `insert into audit_log (id, owner_id, action) values ('${FIXTURE.audit(o)}', '${user}', 'sign_in')`,
    );
    await run(
      db,
      `insert into usage_events (id, owner_id, event) values ('${FIXTURE.usage(o)}', '${user}', 'batch_generated')`,
    );
    await run(
      db,
      `insert into deletion_log (id, owner_id, entity, entity_id, counts) values ('${FIXTURE.deletion(o)}', '${user}', 'question', '${FIXTURE.question(o)}', '{"versions": 1}')`,
    );
    await run(
      db,
      `insert into school_templates (id, owner_id, name, school_name, is_default)
       values ('${FIXTURE.template(o)}', '${user}', 'Kop sekolah', 'SMP Contoh', true)`,
    );
    await run(
      db,
      `insert into assessments (id, owner_id, title, kind, grade, template_id)
       values ('${FIXTURE.assessment(o)}', '${user}', 'Ulangan bab 1', 'ulangan_harian', 8, '${FIXTURE.template(o)}')`,
    );
    await run(
      db,
      `insert into assessment_sections (id, owner_id, assessment_id, title, sort_order)
       values ('${FIXTURE.section(o)}', '${user}', '${FIXTURE.assessment(o)}', 'A. Pilihan ganda', 0)`,
    );
    await run(
      db,
      `insert into assessment_items (id, owner_id, assessment_id, section_id, question_id, question_version_id, sort_order, points)
       values ('${FIXTURE.item(o)}', '${user}', '${FIXTURE.assessment(o)}', '${FIXTURE.section(o)}', '${FIXTURE.question(o)}', '${FIXTURE.version(o)}', 0, 10)`,
    );
    await run(
      db,
      `insert into exports (id, owner_id, assessment_id, document, format, object_key, snapshot_hash, expires_at, job_id)
       values ('${FIXTURE.export(o)}', '${user}', '${FIXTURE.assessment(o)}', 'paper', 'pdf', 'exports/${user}/${FIXTURE.export(o)}/soal.pdf', 'hash', now() + interval '7 days', '${FIXTURE.job(o)}')`,
    );
    await run(
      db,
      `insert into question_usages (id, owner_id, question_id, question_version_id, assessment_id, export_id)
       values ('${FIXTURE.questionUsage(o)}', '${user}', '${FIXTURE.question(o)}', '${FIXTURE.version(o)}', '${FIXTURE.assessment(o)}', '${FIXTURE.export(o)}')`,
    );
    await run(
      db,
      `insert into folders (id, owner_id, name) values ('${FIXTURE.folder(o)}', '${user}', 'Buku paket')`,
    );
    await run(
      db,
      `insert into materials (id, owner_id, folder_id, title, kind, mime, size_bytes, sha256, object_key, page_count, grade, academic_year, status)
       values ('${FIXTURE.material(o)}', '${user}', '${FIXTURE.folder(o)}', 'Matematika kelas 8', 'pdf', 'application/pdf', 1024, '${"a".repeat(64)}', 'materials/${user}/${FIXTURE.material(o)}/file.pdf', 1, 8, '2026/2027', 'ready')`,
    );
    await run(
      db,
      `insert into material_sections (id, owner_id, material_id, title, kind, page_start, page_end, topic_id)
       values ('${FIXTURE.materialSection(o)}', '${user}', '${FIXTURE.material(o)}', 'Bab 1 Pola bilangan', 'chapter', 1, 1, '${FIXTURE.topic}')`,
    );
    await run(
      db,
      `insert into material_pages (id, owner_id, material_id, page_no, text_md, text_source, confidence)
       values ('${FIXTURE.materialPage(o)}', '${user}', '${FIXTURE.material(o)}', 1, 'Pola bilangan ganjil', 'pdf_text', 'high')`,
    );
    await run(
      db,
      `insert into ocr_usage (id, owner_id, day, pages) values ('${FIXTURE.ocrUsage(o)}', '${user}', '2026-11-20', 3)`,
    );
    await run(
      db,
      `insert into material_uploads (id, owner_id, object_key, kind, mime, size_bytes, expires_at)
       values ('${FIXTURE.materialUpload(o)}', '${user}', 'materials/${user}/${FIXTURE.materialUpload(o)}/source.pdf', 'pdf', 'application/pdf', 2048, '2026-11-20T04:00:00Z')`,
    );
    await run(
      db,
      `insert into solver_sessions (id, owner_id, input_kind, input_text, confirmed_md, status)
       values ('${FIXTURE.solverSession(o)}', '${user}', 'text', 'Berapa 2 + 3?', 'Berapa 2 + 3?', 'solved')`,
    );
    await run(
      db,
      `insert into solver_solutions (id, owner_id, session_id, method_label, steps, final_answer, verification_status)
       values ('${FIXTURE.solverSolution(o)}', '${user}', '${FIXTURE.solverSession(o)}', 'Penjumlahan langsung', '[]', '{"value": "5"}', 'terverifikasi')`,
    );
    await run(
      db,
      `insert into app_errors (id, owner_id, source, message) values ('${FIXTURE.appError(o)}', '${user}', 'job', 'boom')`,
    );
  }
}
