# Curriculum seed files

Versioned JSON files that describe the Kurikulum Merdeka Mathematics catalogue for SMP Grades 7–9, Fase D. They are loaded by the seed script and validated by `validateSeed` in `src/features/curriculum/schema/seed-schema.ts`.

## Rules

- One file per curriculum version, named `<version.code>.json`.
- Every topic and every learning objective must cite its source in `sourceRef` (document, edition, and page or chapter).
- `stableKey` never changes once a question refers to it. A renamed topic keeps its key; a topic that is replaced gets a new key and the old one stays.
- Topic grades come from the chapter structure of the official Kemendikbud textbooks; learning objectives come from official ATP examples where they exist (ADR-0014, D-005).
- The developer validates the list against the official sources before it is used, and the teacher confirms it during the pilot.
- Never invent content. If a source is missing, leave the topic out and record the gap in `docs/research/curriculum-sources.md`.

Real seed files are added in Phase 0D (tasks P0-10 to P0-12).
