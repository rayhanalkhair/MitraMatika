// The document model (decision 8): everything the three documents print, resolved once from the
// pinned snapshot and the school template, so the HTML renderer (and the DOCX renderer of Task 7)
// only lay it out. Documents are Indonesian whatever the UI language is.
//
// Numbering: items come in `numberedOrder(sections, seed)` (Task 5), which is the shuffled order
// when shuffle is on. The paper, the key and the solutions all read this one list, so the key's
// No / Jawaban / Skor rows can never drift from the numbers printed on the paper.
import {
  snapshotOrder,
  snapshotPoints,
  type ApprovalSnapshot,
} from "@/features/assessments";
import {
  sanitizeSvg,
  type PaperSize,
  type StudentField,
  type TemplateFont,
  type TemplateView,
} from "@/features/templates";
import { optionColumns, type OptionColumns } from "./columns";

export type OptionLabel = "A" | "B" | "C" | "D";

/** The content of one pinned question version. */
export interface ExportVersion {
  stemMd: string;
  options: { label: OptionLabel; textMd: string }[];
  correctLabel: OptionLabel | null;
  steps: string[];
  explanationMd: string;
}

/** The approval snapshot (structure, order, seed, scoring) plus the content of each pinned version. */
export interface ExportSnapshot extends ApprovalSnapshot {
  versions: ReadonlyMap<string, ExportVersion>;
}

export interface ExportItem {
  itemId: string;
  /** The number printed on the paper (1..n across sections, shuffled when shuffle is on). */
  number: number;
  stemMd: string;
  options?: { label: OptionLabel; textMd: string }[];
  columns: OptionColumns;
  /** The points after the scoring mode. */
  points: number;
  /** The correct answer as the key prints it (the option letter). */
  answerMd: string;
  steps: string[];
}

export interface ExportDocument {
  meta: {
    title: string;
    kindLabel: string;
    grade: number;
    /** "Selasa, 17 November 2026" */
    examDate: string | null;
    durationMinutes: number | null;
    instructionsMd: string | null;
    subject: string;
  };
  header: {
    schoolName: string;
    /** Printed ABOVE the school name, as in the letterhead preview of the Settings card. */
    lines: string[];
    /** The logo as an image data URI (never inline markup, Ruling R13), or null. */
    logoDataUri: string | null;
  };
  studentFields: { key: StudentField; label: string }[];
  sections: { title: string; instructionsMd: string | null; items: ExportItem[] }[];
  page: { paper: PaperSize; font: TemplateFont };
}

const KIND_LABELS: Record<string, string> = {
  latihan: "Latihan Soal",
  ulangan_harian: "Ulangan Harian",
  sts: "Sumatif Tengah Semester",
  sas: "Sumatif Akhir Semester",
  custom: "Asesmen",
};

const STUDENT_FIELD_LABELS: Record<StudentField, string> = {
  name: "Nama",
  class: "Kelas",
  number: "No. absen",
  date: "Tanggal",
};

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** "2026-11-17" -> "Selasa, 17 November 2026" (anything else is printed as given). */
export function formatExamDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return value;
  return `${DAYS[date.getUTCDay()]}, ${String(day)} ${MONTHS[month - 1]} ${String(year)}`;
}

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml"]);

/**
 * The logo as a base64 image data URI, for an <img> only (Ruling R13). A raster is encoded as it
 * is; an SVG is sanitised again (the stored bytes were sanitised at upload, this is defence in
 * depth) and a failure drops the logo. Base64 keeps the SVG namespace URL out of the HTML text.
 */
function logoDataUri(
  logo: { bytes: Uint8Array; contentType: string } | null | undefined,
): string | null {
  if (!logo || !LOGO_TYPES.has(logo.contentType)) return null;
  let bytes = logo.bytes;
  if (logo.contentType === "image/svg+xml") {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    const clean = sanitizeSvg(source);
    if (!clean.ok) return null;
    bytes = new TextEncoder().encode(clean.data);
  }
  return `data:${logo.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function buildDocumentModel(
  snapshot: ExportSnapshot,
  template: TemplateView | null,
  options?: { logo?: { bytes: Uint8Array; contentType: string } | null },
): ExportDocument {
  const items = new Map(
    snapshot.sections
      .flatMap((section) => section.items)
      .map((item) => [item.itemId, item]),
  );
  const points = snapshotPoints(snapshot);
  const numbered = new Map(snapshotOrder(snapshot).map((s) => [s.sectionId, s.items]));

  const sections = snapshot.sections.map((section) => ({
    title: section.title,
    instructionsMd: section.instructionsMd,
    items: (numbered.get(section.id) ?? []).map(({ itemId, number }): ExportItem => {
      const item = items.get(itemId);
      const content = item ? snapshot.versions.get(item.versionId) : undefined;
      if (!item || !content) {
        throw new Error("export: the content of a pinned question version is missing");
      }
      const hasOptions = content.options.length > 0;
      return {
        itemId,
        number,
        stemMd: content.stemMd,
        ...(hasOptions ? { options: content.options } : {}),
        columns: optionColumns(content.options.map((option) => option.textMd)),
        // Not computable (normalised with no points): the stored points stand in.
        points: points?.get(itemId) ?? item.storedPoints,
        answerMd: content.correctLabel ?? "",
        steps: content.steps,
      };
    }),
  }));

  return {
    meta: {
      title: snapshot.title,
      kindLabel: KIND_LABELS[snapshot.kind] ?? KIND_LABELS.custom,
      grade: snapshot.grade,
      examDate: formatExamDate(snapshot.examDate),
      durationMinutes: snapshot.durationMinutes,
      instructionsMd: snapshot.instructionsMd ?? template?.defaultInstructions ?? null,
      subject: template?.subject ?? "Matematika",
    },
    header: {
      schoolName: template?.schoolName ?? "",
      lines: [...(template?.headerLines ?? [])],
      logoDataUri: logoDataUri(options?.logo),
    },
    studentFields: (template?.studentFields ?? ["name", "class"]).map((key) => ({
      key,
      label: STUDENT_FIELD_LABELS[key],
    })),
    sections,
    page: { paper: template?.paperSize ?? "A4", font: template?.font ?? "times" },
  };
}

/** The answer key rows, in paper order: the same numbers the paper prints. */
export function keyRows(
  doc: ExportDocument,
): { number: number; answer: string; points: number }[] {
  return doc.sections
    .flatMap((section) => section.items)
    .map((item) => ({ number: item.number, answer: item.answerMd, points: item.points }))
    .sort((a, b) => a.number - b.number);
}
