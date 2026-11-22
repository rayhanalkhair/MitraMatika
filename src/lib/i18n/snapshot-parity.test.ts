import { describe, expect, it } from "vitest";
import { createStaticTranslator, hasMessageKey } from "./translator";

// Expected strings are copied from the old `copy` object (src/lib/i18n/id.ts at 65f305e):
// the move to next-intl must not change one character of the Indonesian UI.
const t = createStaticTranslator();

describe("Indonesian catalog matches the old copy exactly", () => {
  it("renders every former function entry with the old output", () => {
    expect(t("buatSoal.resultCount", { count: 3 })).toBe("3 topik ditemukan");
    expect(t("buatSoal.resultCount", { count: 1 })).toBe("1 topik ditemukan");
    expect(t("buatSoal.noMatch", { query: "xyz" })).toBe(
      'Tidak ada topik yang cocok dengan "xyz".',
    );
    expect(t("buatSoal.objectivesSummary", { count: "2" })).toBe(
      "Tujuan pembelajaran (2)",
    );
    expect(t("generate.status.progress", { done: "2", total: "5" })).toBe(
      "Langkah 2 dari 5",
    );
    expect(t("generate.status.deferredTitle", { time: "14.30" })).toBe(
      "Kuota AI harian habis. Pekerjaan dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    );
    expect(t("generate.status.deferredMinuteTitle", { time: "14.30" })).toBe(
      "Menunggu giliran layanan AI. Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    );
    expect(t("generate.status.deferredProviderTitle", { time: "14.30" })).toBe(
      "Layanan AI sedang membatasi permintaan. Dilanjutkan otomatis setelah layanan AI tersedia lagi, paling cepat pukul 14.30",
    );
    expect(t("bank.savedOn", { date: "8 November 2026" })).toBe(
      "Disimpan 8 November 2026",
    );
    expect(t("beranda.running.quantity", { count: 10 })).toBe("10 soal");
    expect(t("beranda.pending.undecided", { count: "2" })).toBe("2 belum diputuskan");
    expect(t("beranda.pending.ready", { count: "3" })).toBe("3 siap disimpan");
    expect(t("review.ready", { count: 5 })).toBe("5 soal siap ditinjau");
    expect(t("review.showing", { shown: 3, requested: 5 })).toBe(
      "Menampilkan 3 dari 5 soal",
    );
    expect(t("review.questionHeading", { number: "2" })).toBe("Soal 2");
    expect(t("review.stepsSummary", { count: "4" })).toBe("Langkah penyelesaian (4)");
    expect(t("review.bank.ready", { count: 3 })).toBe("3 soal disetujui siap disimpan");
    expect(t("review.bank.saved", { count: 2 })).toBe("2 soal tersimpan");
    expect(t("review.decision.overrideNoteHint", { min: "10", max: "500" })).toBe(
      "10–500 karakter",
    );
    expect(t("review.sheetTitle", { number: "3" })).toBe("Detail pemeriksaan soal 3");
  });

  it("does not group the digits of a numeric argument (the old code used String(n))", () => {
    expect(t("beranda.running.quantity", { count: 1234567 })).toBe("1234567 soal");
  });

  it("renders plain strings unchanged, including the long and the punctuated ones", () => {
    expect(t("nav.penyusunAsesmen")).toBe("Penyusun Asesmen");
    expect(t("buatSoal.grades.8")).toBe("Kelas 8");
    expect(t("buatSoal.gradeComingSoon")).toBe(
      "Kelas ini segera hadir. Menampilkan topik Kelas 8.",
    );
    expect(t("buatSoal.unavailableEmpty")).toBe(
      "Daftar topik belum tersedia. Kurikulum belum diaktifkan; hubungi pengembang.",
    );
    expect(t("generate.errors.topicUnknown")).toBe(
      "Topik tidak ditemukan atau belum aktif. Muat ulang halaman.",
    );
    // The old catalog carries a U+FFFD where an ellipsis was meant; kept byte for byte.
    expect(t("generate.status.succeededLoadingDetail")).toBe("Soal sedang dimuat…");
    expect(t("review.loading")).toBe("Memuat soal…");
    expect(t("review.decision.overrideIntro")).toBe(
      "Pemeriksaan otomatis menemukan ketidaksesuaian pada soal ini. Setujui hanya jika Anda sudah memeriksanya sendiri.",
    );
    expect(t("review.decision.overrideConfirm")).toBe(
      "Saya sudah memeriksa; kunci jawaban benar",
    );
    expect(t("review.statusExplanations.dicek_silang")).toBe(
      "Hitungan otomatis belum bisa dipakai, tetapi penyelesai AI independen memilih jawaban yang sama.",
    );
    expect(t("review.regenerated")).toBe(
      "Soal ini dibuat ulang satu kali secara otomatis karena pemeriksaan pertama menemukan ketidaksesuaian.",
    );
    expect(t("auth.errors.oauthDenied")).toBe(
      "Masuk dengan Google dibatalkan atau ditolak.",
    );
  });

  it("renders the English catalog for the same keys and arguments", () => {
    const buatSoal = createStaticTranslator("buatSoal", "en");
    expect(buatSoal("resultCount", { count: "3" })).toBe("3 topics found");
    expect(createStaticTranslator("nav", "en")("bankSoal")).toBe("Question bank");
  });

  it("renders numeric counts without grouping in Indonesian and with grouping in English", () => {
    expect(t("review.ready", { count: 7 })).toBe("7 soal siap ditinjau");
    expect(t("review.ready", { count: 0 })).toBe("0 soal siap ditinjau");
    expect(t("review.showing", { shown: 1000, requested: 12345 })).toBe(
      "Menampilkan 1000 dari 12345 soal",
    );
    const en = createStaticTranslator("review", "en");
    expect(en("showing", { shown: 1000, requested: 1200 })).toBe(
      "Showing 1,000 of 1,200 questions",
    );
  });
});

describe("English plurals", () => {
  const cases: [string, string, Record<string, number>, string[]][] = [
    ["buatSoal", "resultCount", { count: 0 }, ["0 topics found"]],
    ["buatSoal", "resultCount", { count: 1 }, ["1 topic found"]],
    ["buatSoal", "resultCount", { count: 2 }, ["2 topics found"]],
    ["beranda", "running.quantity", { count: 0 }, ["0 questions"]],
    ["beranda", "running.quantity", { count: 1 }, ["1 question"]],
    ["beranda", "running.quantity", { count: 2 }, ["2 questions"]],
    ["review", "ready", { count: 0 }, ["0 questions ready for review"]],
    ["review", "ready", { count: 1 }, ["1 question ready for review"]],
    ["review", "ready", { count: 2 }, ["2 questions ready for review"]],
    ["review", "bank.ready", { count: 0 }, ["0 approved questions ready to save"]],
    ["review", "bank.ready", { count: 1 }, ["1 approved question ready to save"]],
    ["review", "bank.ready", { count: 2 }, ["2 approved questions ready to save"]],
    ["review", "bank.saved", { count: 0 }, ["0 questions saved"]],
    ["review", "bank.saved", { count: 1 }, ["1 question saved"]],
    ["review", "bank.saved", { count: 2 }, ["2 questions saved"]],
    ["review", "showing", { shown: 0, requested: 0 }, ["Showing 0 of 0 questions"]],
    ["review", "showing", { shown: 1, requested: 1 }, ["Showing 1 of 1 question"]],
    ["review", "showing", { shown: 1, requested: 2 }, ["Showing 1 of 2 questions"]],
  ];

  it.each(cases)("%s.%s %j", (namespace, key, values, [expected]) => {
    const en = createStaticTranslator(namespace as "review", "en") as unknown as (
      key: string,
      values: Record<string, number>,
    ) => string;
    expect(en(key, values)).toBe(expected);
  });
});

describe("hasMessageKey", () => {
  it("finds keys directly under a dotted namespace only", () => {
    expect(hasMessageKey("auth.errors", "oauthDenied")).toBe(true);
    expect(hasMessageKey("auth.errors", "nope")).toBe(false);
    expect(hasMessageKey("auth.errors", "constructor")).toBe(false);
    expect(hasMessageKey("auth.missing", "oauthDenied")).toBe(false);
    expect(hasMessageKey("nav.bankSoal", "x")).toBe(false);
  });
});
