# Golden set (P0-16)

The fixed input/expected-output set used by the P0-17 eval harness and the
P0-18 benchmark to score generation, the independent solver, and OCR against
known-correct answers, per `docs/development/implementation-plan.md` §8.2
(epic 0E) and its exit criteria.

All Grade 8 content, since only the Grade 8 curriculum seed is validated yet
(Grade 9's seed is Phase 2, task P2-08) — see the developer-user exchange this
set was scoped from.

## Files

| File | Committed? | What it is |
|---|---|---|
| `generation-specs.v1.json` | yes | 20 input specs (grade/topic/difficulty) for `generate_questions`. No expected content — generation produces new questions each run; P0-17 scores the *output* (schema validity, key accuracy via the verifier, Indonesian quality). |
| `solver-problems.v1.json` | yes | 10 complete multiple-choice questions (stem + 4 options + known correct answer), shaped to match `SolveIndependentParams` — these test `solve_independent` (`src/features/generation/service/solve-independent.ts`) against a known-correct answer, not a free-form word problem. |
| `ocr-pages-manifest.v1.json` | yes | Ids, kind, page number, a SHA-256 of the real transcription, and a citation for 10 OCR fixtures — **no real content**. |
| *(local only, gitignored)* `.spikes-output/fixtures/ocr-pages/ocr-pages.v1.json` | **no** | The real page images and their ground-truth transcriptions. Regenerate by re-running the extraction against the source PDF below; the manifest's `sha256` is `sha256(expectedText_md)` per item, so a content edit there is detectable even though the content itself isn't in git. |
| *(local only, gitignored)* `.spikes-output/fixtures/Matematika-BS-KLS-VIII-Baru.pdf` | **no** | The source textbook (see Sourcing below). |
| *(local only, gitignored)* `.spikes-output/fixtures/ocr-pages/*.png`, `*.jpg` | **no** | The rendered "scan" images and the one real "phone photo". |

## Sourcing and licensing

**Generation specs and solver problems are original content**, written to match
the topic, difficulty, and phrasing style of a real Grade 8 textbook — not
verbatim excerpts. Where a solver problem's `sourceRef` cites a specific page,
that means "written in the style of," not "copied from" (each one says so
explicitly).

**The OCR set is different: it necessarily reproduces real textbook pages
verbatim**, since the whole point is testing whether OCR can transcribe an
actual scanned page correctly. That content is copyrighted (see below), so it
follows the project's existing rule for this exact situation
(`docs/development/implementation-plan.md` §10.2, "Test data"): copyrighted
golden-set items stay outside git; only their ids and hashes are committed.

### The source book

**Matematika untuk SMP/MTs Kelas VIII**, Kementerian Pendidikan, Kebudayaan,
Riset, dan Teknologi RI, 2022. ISBN 978-602-427-919-6 (jil. 2 — this is
Volume 2 of a 2-volume set; it covers Bilangan Berpangkat, Teorema Pythagoras,
Persamaan/Pertidaksamaan Linear Satu Variabel, Relasi & Fungsi, Persamaan
Garis Lurus, and Statistika, but not Lingkaran, Garis-dan-Sudut, or Peluang —
those are presumably in Volume 1, not used here). Downloaded from the
official government portal, buku.kemendikdasmen.go.id (mirrored from
buku.kemdikbud.go.id).

**License, as actually printed on the book's copyright page** (verified by
reading it directly, not assumed): "Hak Cipta pada Kementerian Pendidikan,
Kebudayaan, Riset, dan Teknologi Republik Indonesia. Dilindungi
Undang-Undang." (Copyright held by the Ministry, protected by law.) This is
**not** an open license like CC BY-NC — it's standard copyright, free to
download and read via the official portal but not an open redistribution
grant. Hence the git-exclusion approach above, rather than committing real
excerpts.

### A note on curriculum coverage

This book's table of contents doesn't include Lingkaran, Garis-dan-Sudut, or
Peluang (see above) — consistent with the "likely gap" flagged during P0-12's
curriculum validation regarding 3D-solids coverage, though this is a
different book/volume than whatever her actual assigned textbook is, so it
doesn't resolve that gap, just adds one independent data point. Generation
specs and solver problems for those three topics are grounded directly in the
already-validated `data/curriculum/grade-8-v1.json` (official CP citations)
rather than this book.

## OCR fixture breakdown (10 items)

- 3 `text_pdf` — real pages of the source PDF, referenced by page number
  directly (no separate file: an OCR pipeline selects a page from a
  multi-page document, same as the real product's MAT-05 page selection).
- 6 `scan` — real pages rendered to PNG via `unpdf`'s `renderPageAsImage`
  (`@napi-rs/canvas` backend), closing out the previously untested half of
  ADR-0012 ("page rendering on Vercel Hobby" / "OCR of one scan").
- 1 `phone_photo` — **pending.** The manifest entry
  (`ocr-phone-photo-kubus-berpangkat-1`) and its ground-truth transcription
  are in place, citing page 26 (the Bab 1 kubus/pangkat-tiga table), but the
  actual photo file
  (`.spikes-output/fixtures/ocr-pages/phone-photo-page-26.jpg`) hasn't been
  taken yet — a real phone photo needs an actual phone and printed/displayed
  page, which isn't something to fake. Take it whenever convenient (the
  reference render was sent separately) and drop it at that path; nothing
  else needs to change, since the manifest's hash is only over the
  transcription text, not the image. Until then, P0-17's eval harness will
  have 9 of 10 OCR fixtures usable, and this is the one piece of ADR-0012's
  "entirely untested" OCR/vision-model half still open.

## Regenerating the local content

1. Re-download the source PDF into `.spikes-output/fixtures/` if missing
   (see the URL above).
2. Rebuild the OCR fixtures (rendering + manifest hashing) with a short
   script using `unpdf`'s `getDocumentProxy`/`renderPageAsImage` and
   `goldenOcrSetSchema` from `src/features/eval/schema/golden-set-schema.ts` — see
   git history for the exact script if needed; it isn't kept since it's a
   one-off.
