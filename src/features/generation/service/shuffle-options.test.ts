import { describe, expect, it } from "vitest";
import {
  multipleChoiceQuestionSchema,
  type MultipleChoiceQuestion,
} from "../schema/schemas";
import { hashSeed } from "./seeded-shuffle";
import { shuffleQuestionOptions } from "./shuffle-options";
import { questionJson } from "./test-support";

const make = (patch: Record<string, unknown> = {}): MultipleChoiceQuestion =>
  multipleChoiceQuestionSchema.parse({ ...questionJson(3), ...patch });

const withTexts = (texts: string[], correctLabel = "A", patch = {}) =>
  make({
    options: texts.map((text_md, i) => ({ label: "ABCD"[i], text_md })),
    correctLabel,
    ...patch,
  });

const keyText = (q: {
  options: { label: string; text_md: string }[];
  correctLabel: string;
}) => q.options.find((o) => o.label === q.correctLabel)?.text_md;

describe("shuffleQuestionOptions", () => {
  it("keeps the correct option text and re-letters A-D in order", () => {
    for (let s = 0; s < 50; s += 1) {
      const q = withTexts(["alpha", "beta", "gamma", "delta"], "C");
      const out = shuffleQuestionOptions(q, s);
      expect(keyText(out)).toBe("gamma");
      expect(out.options.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
      expect(out.options.map((o) => o.text_md).sort()).toEqual([
        "alpha",
        "beta",
        "delta",
        "gamma",
      ]);
      expect(multipleChoiceQuestionSchema.safeParse(out).success).toBe(true);
    }
  });

  it("does not mutate its input", () => {
    const q = withTexts(["alpha", "beta", "gamma", "delta"], "A");
    const snapshot = structuredClone(q);
    shuffleQuestionOptions(q, 1);
    expect(q).toEqual(snapshot);
  });

  it("is deterministic for the same seed and differs across seeds", () => {
    const q = withTexts(["alpha", "beta", "gamma", "delta"], "A");
    expect(shuffleQuestionOptions(q, 9)).toEqual(shuffleQuestionOptions(q, 9));
    const orders = new Set<string>();
    for (let s = 0; s < 40; s += 1) {
      orders.add(
        shuffleQuestionOptions(q, s)
          .options.map((o) => o.text_md)
          .join("|"),
      );
    }
    expect(orders.size).toBeGreaterThan(5);
  });

  it("spreads the key roughly uniformly over 1000 seeds", () => {
    const q = withTexts(["alpha", "beta", "gamma", "delta"], "A");
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (let i = 0; i < 1000; i += 1) {
      const out = shuffleQuestionOptions(q, hashSeed(`req-1:${String(i)}`));
      counts[out.correctLabel] = (counts[out.correctLabel] ?? 0) + 1;
    }
    for (const label of ["A", "B", "C", "D"]) {
      expect(counts[label]).toBeGreaterThanOrEqual(150);
      expect(counts[label]).toBeLessThanOrEqual(350);
    }
  });

  it.each([
    "Semua jawaban benar",
    "Tidak ada jawaban yang benar",
    "Semua benar",
    "semua di atas benar",
    "SEMUA PILIHAN DI ATAS BENAR",
    "Tidak ada yang benar",
  ])("keeps %j last", (special) => {
    for (let s = 0; s < 30; s += 1) {
      const q = withTexts(["10", "20", "30", special], "B");
      const out = shuffleQuestionOptions(q, s);
      expect(out.options[3].text_md).toBe(special);
      expect(keyText(out)).toBe("20");
    }
  });

  it("keeps several such options last in their original relative order", () => {
    for (let s = 0; s < 30; s += 1) {
      const q = withTexts(
        ["10", "20", "Semua benar", "Tidak ada jawaban yang benar"],
        "A",
      );
      const out = shuffleQuestionOptions(q, s);
      expect(out.options.slice(2).map((o) => o.text_md)).toEqual([
        "Semua benar",
        "Tidak ada jawaban yang benar",
      ]);
      expect(keyText(out)).toBe("10");
    }
  });

  it("keeps the key on a pinned option pointing at that option", () => {
    const q = withTexts(["10", "20", "30", "Semua jawaban benar"], "D");
    const out = shuffleQuestionOptions(q, 5);
    expect(out.correctLabel).toBe("D");
    expect(keyText(out)).toBe("Semua jawaban benar");
  });

  it("works with two, three and five options", () => {
    for (const n of [2, 3, 5]) {
      const texts = Array.from({ length: n }, (_, i) => `opt${String(i)}`);
      const labels = "ABCDE".slice(0, n).split("");
      const base = {
        options: texts.map((text_md, i) => ({ label: labels[i], text_md })),
        correctLabel: "A",
      };
      const seen = new Set<string>();
      for (let s = 0; s < 60; s += 1) {
        const out = shuffleQuestionOptions(base, s);
        expect(out.options.map((o) => o.label)).toEqual(labels);
        expect(keyText(out)).toBe("opt0");
        expect([...out.options.map((o) => o.text_md)].sort()).toEqual(texts);
        seen.add(out.correctLabel);
      }
      expect(seen.size).toBe(n);
    }
  });

  it("leaves a question without options untouched", () => {
    const notMc = { stem_md: "Jelaskan.", correctLabel: "A" } as never;
    expect(shuffleQuestionOptions(notMc, 3)).toBe(notMc);
    const single = { options: [{ label: "A", text_md: "x" }], correctLabel: "A" };
    expect(shuffleQuestionOptions(single, 3)).toBe(single);
  });

  it("leaves a question whose key matches no option untouched", () => {
    const q = {
      options: [
        { label: "A", text_md: "x" },
        { label: "B", text_md: "y" },
      ],
      correctLabel: "Z",
    };
    expect(shuffleQuestionOptions(q, 3)).toBe(q);
  });

  it("pins more last-position options", () => {
    for (const special of [
      "Bukan salah satu di atas",
      "Tidak satu pun benar",
      "Semua salah",
      "Jawaban di atas tidak ada yang tepat",
    ]) {
      for (let s = 0; s < 20; s += 1) {
        const out = shuffleQuestionOptions(
          withTexts(["10", "20", "30", special], "A"),
          s,
        );
        expect(out.options[3].text_md).toBe(special);
        expect(keyText(out)).toBe("10");
      }
    }
  });

  it("never rewrites any text", () => {
    const q = withTexts(["alpha", "beta", "gamma", "delta"], "A", {
      stem_md: "Titik A dan B terletak pada garis. Pilih yang benar.",
      explanation_md: "Panjang AB dihitung dari titik A ke titik B.",
      steps: ["Gambar segitiga ABC.", "Hitung sisi AB."],
    });
    const out = shuffleQuestionOptions(q, 11);
    expect(out.stem_md).toBe(q.stem_md);
    expect(out.explanation_md).toBe(q.explanation_md);
    expect(out.steps).toEqual(q.steps);
    expect(out.answer).toEqual(q.answer);
  });

  const shuffled = (q: MultipleChoiceQuestion) => {
    for (let s = 0; s < 20; s += 1) {
      if (shuffleQuestionOptions(q, s) !== q) return true;
    }
    return false;
  };

  describe("leaves the question unshuffled when a letter may be referenced", () => {
    it.each([
      [
        "stem names choices pilihan A / pilihan B",
        {
          stem_md:
            "Toko memberi dua pilihan: pilihan A diskon 20%, pilihan B potong Rp5.000. Mana yang lebih hemat?",
        },
      ],
      ["stem: opsi (C)", { stem_md: "Jika memilih opsi (C), berapa biayanya?" }],
      ["stem: jawaban D", { stem_md: "Bandingkan dengan jawaban D di bawah." }],
      ["stem: range A-D", { stem_md: "Pilih salah satu dari A-D." }],
      ["stem: range A–D", { stem_md: "Pilih salah satu dari A–D." }],
      ["stem: list", { stem_md: "Pilih A, B, C, atau D yang tepat." }],
      [
        "explanation: Jadi, jawabannya adalah B.",
        { explanation_md: "Dua kali tiga adalah enam. Jadi, jawabannya adalah B." },
      ],
      ["explanation: Jawaban yang benar: B", { explanation_md: "Jawaban yang benar: B" }],
      ["explanation: Jawaban: B", { explanation_md: "Hitung dahulu. Jawaban: B" }],
      [
        "explanation: (B) with tepat",
        { explanation_md: "Jadi, jawaban yang tepat adalah (B)." },
      ],
      ["explanation: kunci C", { explanation_md: "Kunci C karena hasilnya enam." }],
      ["step: pilihan A", { steps: ["Hitung nilainya.", "Maka pilihan A salah."] }],
      ["step: jawaban benar B", { steps: ["Hitung nilainya.", "Jadi yang benar B."] }],
      ["display_md is a bare letter", { answer: { display_md: "B", machine: "6" } }],
      [
        "display_md is a letter with text",
        { answer: { display_md: "B. 12 cm", machine: "12" } },
      ],
      ["display_md in parentheses", { answer: { display_md: "(C) 6", machine: "6" } }],
    ])("%s", (_name, patch) => {
      const q = withTexts(["5", "6", "7", "8"], "B", patch);
      expect(shuffled(q)).toBe(false);
    });

    it.each([
      "A",
      "b",
      "(C)",
      "D.",
      "Hanya B",
      "B saja",
      "Pilihan A",
      "Opsi C",
      "A dan B benar",
      "B, C, dan D",
      "Jawaban D",
    ])("option %j", (text) => {
      const q = withTexts(["5", "6", "7", text], "B");
      expect(shuffled(q)).toBe(false);
    });
  });

  describe("still shuffles when letters are only math labels", () => {
    it.each([
      [
        "titik A dan B",
        {
          stem_md: "Titik A dan B berjarak 5 cm. Berapa panjang AB?",
          explanation_md: "Jarak titik A dan B adalah 5 cm.",
        },
      ],
      [
        "segitiga ABC",
        {
          stem_md: "Segitiga ABC siku-siku di B.",
          steps: ["Gambar segitiga ABC.", "Hitung sisi AB."],
        },
      ],
      [
        "coordinates and angle",
        {
          stem_md: "Titik (A, B) pada bidang.",
          explanation_md: "Sudut A adalah 30 derajat, sehingga luasnya 12.",
        },
      ],
      [
        "letters inside math",
        {
          explanation_md: "Jadi $B = 6$ dan hasilnya benar karena $A + B = 10$.",
          steps: ["Hitung $A$.", "Hitung $B$."],
        },
      ],
      [
        "letter far from any answer word",
        {
          explanation_md:
            "Misalkan titik A adalah pusat lingkaran, lalu gambarlah garis yang melalui pusat tersebut ke tepi lingkaran dan hitung jawabannya.",
        },
      ],
      ["a normal word problem", { stem_md: "Ani membeli 3 pensil seharga Rp2.000." }],
    ])("%s", (_name, patch) => {
      const q = withTexts(["5", "6", "7", "8"], "B", patch);
      expect(shuffled(q)).toBe(true);
    });
  });

  describe("re-review: must skip", () => {
    const expl = (explanation_md: string) => ({ explanation_md });
    it.each([
      ["parenthesised (B) after yaitu", expl("Hasilnya 12 cm, yaitu (B).")],
      ["parenthesised (B) alone", expl("Hasilnya 12 cm (B).")],
      ["parenthesised (C) in a clause", expl("Diperoleh 14 cm (C), yang salah.")],
      ["parenthesised lowercase (b)", expl("Jawaban yang benar adalah (b).")],
      ["step with (A)", { steps: ["Hitung.", "Hasilnya (A)."] }],
      ["display with (B)", { answer: { display_md: "$12$ cm (B)", machine: "12" } }],
      ["lowercase after opsi", expl("Opsi b benar.")],
      ["lowercase after pilihan", expl("Pilihan c salah.")],
      ["single-letter math $A$", expl("Pilihan $A$ salah karena lupa akar.")],
      ["single-letter math sesuai", expl("Hasilnya $12$ cm, sesuai dengan $\\text{B}$.")],
      ["display $\\text{B}$", { answer: { display_md: "$\\text{B}$", machine: "12" } }],
      [
        "display $\\mathrm{C}$",
        { answer: { display_md: "$\\mathrm{C}$", machine: "12" } },
      ],
      ["ordinal kedua", expl("Hasil 12 cm cocok dengan pilihan kedua.")],
      ["ordinal pertama", expl("Jawaban pertama salah.")],
      ["ordinal terakhir", { steps: ["Hitung.", "Opsi terakhir benar."] }],
      ["ordinal in stem", { stem_md: "Pilih jawaban ketiga atau keempat." }],
      ["Jadi jawabannya adalah B.", expl("Jadi, jawabannya adalah B. $12$ cm.")],
      ["Jawaban: B", { steps: ["Hitung.", "Jawaban: B"] }],
      ["kunci: B", expl("kunci: B")],
      ["B adalah jawaban yang tepat", expl("B adalah jawaban yang tepat")],
      ["maka B yang benar", expl("maka B yang benar")],
      ["dipilih", expl("Maka yang dipilih B.")],
      ["pengecoh", expl("C adalah pengecoh karena lupa akar.")],
      ["salah near letter", expl("Jawaban C salah dan D juga salah.")],
    ])("%s", (_name, patch) => {
      expect(shuffled(withTexts(["5", "6", "7", "8"], "B", patch))).toBe(false);
    });

    it.each(["b dan c", "A and B", "A, B, dan C", "c saja"])("option %j", (text) => {
      expect(shuffled(withTexts(["5", "6", "7", text], "B"))).toBe(false);
    });
  });

  describe("re-review: geometry must not skip", () => {
    const geometry: [string, Record<string, unknown>][] = [
      [
        "stem: siku-siku di B",
        {
          stem_md:
            "Pada segitiga ABC siku-siku di B, panjang $AB = 6$ cm dan $BC = 8$ cm. Panjang AC adalah ...",
        },
      ],
      [
        "stem: di titik B",
        {
          stem_md:
            "Segitiga ABC siku-siku di titik B. Jika AB = 5 cm dan BC = 12 cm, panjang AC adalah ...",
        },
      ],
      [
        "expl: siku-siku di B, jawaban benar",
        {
          explanation_md:
            "Karena siku-siku di B, maka AC adalah sisi miring. Jadi AC = 10 cm, sehingga jawaban benar.",
        },
      ],
      [
        "expl: Sudut B ... yang tepat",
        {
          explanation_md:
            "Sudut B siku-siku, sehingga $AC^2 = AB^2 + BC^2$. Jadi panjang AC yang tepat adalah 10 cm.",
        },
      ],
      [
        "expl: Titik A dan B ... jawabannya",
        { explanation_md: "Titik A dan B berjarak 5 satuan, jadi jawabannya 5." },
      ],
      [
        "expl: siku-siku di C. Hasil yang benar",
        {
          explanation_md:
            "Segitiga dengan sudut siku-siku di C. Hasil yang benar adalah 13 cm.",
        },
      ],
      [
        "expl: titik A(1, 2) dan B(4, 6)",
        {
          explanation_md:
            "Jarak titik A(1, 2) dan B(4, 6) adalah 5, jadi jawaban yang tepat 5.",
        },
      ],
      [
        "expl: math coordinates",
        { explanation_md: "Jarak titik $A(1,2)$ dan $B(4,6)$ adalah 5. Jawabannya 5." },
      ],
      [
        "step: segitiga ABC",
        { steps: ["Perhatikan segitiga ABC, siku-siku di B.", "x"] },
      ],
      [
        "step: sudut B, sehingga benar AC",
        {
          steps: [
            "Sisi miring berhadapan dengan sudut B, sehingga benar AC sisi miring.",
            "x",
          ],
        },
      ],
      [
        "step: PQR siku-siku di Q",
        {
          steps: [
            "Gunakan teorema Pythagoras pada segitiga PQR yang siku-siku di Q.",
            "x",
          ],
        },
      ],
      ["display: AC = 10 cm", { answer: { display_md: "AC = $10$ cm", machine: "10" } }],
      [
        "display: $AC = 10$ cm",
        { answer: { display_md: "$AC = 10$ cm", machine: "10" } },
      ],
      ["display: Titik B", { answer: { display_md: "Titik B", machine: "10" } }],
      ["display: Sudut A", { answer: { display_md: "Sudut A", machine: "10" } }],
      ["display: A = 10", { answer: { display_md: "A = 10", machine: "10" } }],
      ["display: B(4, 6)", { answer: { display_md: "B(4, 6)", machine: "10" } }],
    ];
    it.each(geometry)("%s", (_name, patch) => {
      expect(shuffled(withTexts(["5", "6", "7", "8"], "B", patch))).toBe(true);
    });

    it.each(["Sudut A", "AB dan BC", "A, B, dan C kolinear", "Titik B"])(
      "option %j",
      (text) => {
        expect(shuffled(withTexts(["5", "6", "7", text], "B"))).toBe(true);
      },
    );
  });

  describe("choice_matches_answer claims", () => {
    const claim = {
      type: "choice_matches_answer",
      options: ["5", "6", "7", "8"],
      markedIndex: 1,
      answer: "6",
    };

    it("reorders the claim's options like the question and remaps markedIndex", () => {
      for (let s = 0; s < 30; s += 1) {
        const q = withTexts(["5", "6", "7", "8"], "B", {
          verification_claims: [
            { type: "numeric_eval", expression: "3+3", expected: "6" },
            claim,
          ],
        });
        const out = shuffleQuestionOptions(q, s);
        expect(out.verification_claims[0]).toEqual(q.verification_claims[0]);
        const moved = out.verification_claims[1] as typeof claim;
        expect(moved.options).toEqual(out.options.map((o) => o.text_md));
        expect(moved.options[moved.markedIndex]).toBe("6");
        expect(moved.answer).toBe("6");
        expect(q.verification_claims[1]).toEqual(claim);
      }
    });

    it("leaves a claim whose option count differs alone", () => {
      const odd = { ...claim, options: ["5", "6"], markedIndex: 1 };
      const q = withTexts(["5", "6", "7", "8"], "B", { verification_claims: [odd] });
      expect(shuffleQuestionOptions(q, 3).verification_claims).toEqual([odd]);
    });
  });
});
