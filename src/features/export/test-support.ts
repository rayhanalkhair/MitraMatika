// Test fixtures for the export tests: an approval snapshot with its version content, and a template.
import type { TemplateView } from "@/features/templates";
import type { ExportSnapshot, ExportVersion } from "./service/document-model";

type Label = "A" | "B" | "C" | "D";

export function version(
  stemMd: string,
  correct: Label = "B",
  overrides: Partial<ExportVersion> = {},
): ExportVersion {
  return {
    stemMd,
    options: (["A", "B", "C", "D"] as const).map((label) => ({
      label,
      textMd: `Pilihan ${label}`,
    })),
    correctLabel: correct,
    steps: ["Langkah satu.", "Langkah dua."],
    explanationMd: "",
    ...overrides,
  };
}

/** Two sections: s1 has i1..i3, s2 has i4..i5. Stem of item N is "Soal iN". */
export function snapshot(
  overrides: Partial<ExportSnapshot> = {},
  versions: Record<string, ExportVersion> = {},
): ExportSnapshot {
  const ids = [
    ["s1", ["i1", "i2", "i3"]],
    ["s2", ["i4", "i5"]],
  ] as const;
  const answers: Label[] = ["A", "B", "C", "D", "A"];
  const map = new Map<string, ExportVersion>();
  const sections = ids.map(([sectionId, items]) => ({
    id: sectionId,
    title: sectionId === "s1" ? "A. Pilihan ganda" : "B. Lanjutan",
    instructionsMd: sectionId === "s2" ? "Pilih satu jawaban." : null,
    items: items.map((itemId) => {
      const n = Number(itemId.slice(1));
      map.set(
        `v-${itemId}`,
        versions[itemId] ?? version(`Soal ${itemId}`, answers[n - 1]),
      );
      return {
        itemId,
        questionId: `q-${itemId}`,
        versionId: `v-${itemId}`,
        storedPoints: 0,
        questionApproved: true,
        pinnedIsApproved: true,
        trashed: false,
        mismatch: false,
        overridden: false,
      };
    }),
  }));
  return {
    assessmentId: "a1",
    title: "Ulangan Bab 1",
    kind: "ulangan_harian",
    grade: 7,
    examDate: "2026-11-17",
    durationMinutes: 90,
    instructionsMd: "Berdoalah dahulu.",
    scoringMode: "equal",
    shuffleSeed: null,
    template: {
      id: "t1",
      trashed: false,
      printed: {
        schoolName: "SMP Negeri 1 Contoh",
        headerLines: [],
        logo: null,
        subject: "Matematika",
        studentFields: [],
        defaultInstructionsMd: null,
        paperSize: "A4",
        font: "times",
      },
    },
    sections,
    versions: map,
    ...overrides,
  };
}

/** `count` long items in one section: each stem starts AWAL-nn and ends AKHIR-nn. */
export function longSnapshot(count: number) {
  const base = snapshot();
  const versions = new Map(base.versions);
  const filler =
    "Sebuah toko menjual buku tulis dengan harga yang berbeda setiap minggu sehingga pembeli " +
    "perlu menghitung total belanja dengan cermat sebelum membayar di kasir. ";
  const items = Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    versions.set(
      `v-long-${n}`,
      version(`AWAL-${n} ${filler.repeat(3)}Berapakah hasilnya? AKHIR-${n}`, "A"),
    );
    return {
      ...base.sections[0].items[0],
      itemId: `long-${n}`,
      questionId: `q-long-${n}`,
      versionId: `v-long-${n}`,
    };
  });
  return snapshot({
    sections: [{ ...base.sections[0], items }],
    versions,
  });
}

export const template: TemplateView = {
  id: "t1",
  rowVersion: 1,
  name: "Standar",
  schoolName: "SMP Negeri 1 Contoh",
  headerLines: ["PEMERINTAH KOTA CONTOH", "DINAS PENDIDIKAN", "Jl. Merdeka No. 1"],
  subject: "Matematika",
  studentFields: ["name", "class"],
  defaultInstructions: "Kerjakan dengan jujur.",
  paperSize: "A4",
  font: "times",
  isDefault: true,
  hasLogo: false,
};
