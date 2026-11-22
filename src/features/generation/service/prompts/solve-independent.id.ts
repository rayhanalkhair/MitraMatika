export const SOLVE_INDEPENDENT_PROMPT_VERSION = "solve-independent.id@1";

export interface SolveIndependentParams {
  questionStemMd: string;
  optionTexts_md: [string, string, string, string];
  dataClass: "C0" | "C1" | "C2" | "C3";
}

export function buildSolveIndependentPrompt(params: SolveIndependentParams): {
  system: string;
  prompt: string;
} {
  const system =
    "Kamu adalah asisten yang menyelesaikan soal pilihan ganda matematika SMP secara mandiri, " +
    "dalam Bahasa Indonesia. Kamu TIDAK diberi tahu jawaban resmi mana pun — selesaikan sendiri " +
    "dari nol. Kembalikan HANYA satu objek JSON sesuai skema yang diminta, tanpa teks lain.";

  const [a, b, c, d] = params.optionTexts_md;
  const prompt = `Selesaikan soal pilihan ganda berikut secara mandiri.

Soal: ${params.questionStemMd}
A. ${a}
B. ${b}
C. ${c}
D. ${d}

Ketentuan wajib:
- Tentukan sendiri pilihan mana yang benar (correctLabel), berdasarkan penyelesaianmu sendiri.
- Field "answer.display_md" menggunakan format angka Indonesia (misalnya "2,5").
- Field "answer.machine" menggunakan angka desimal biasa dengan titik (misalnya "2.5").
- Sertakan minimal 1 langkah penyelesaian (steps), gunakan LaTeX $...$ atau $$...$$ bila perlu.
- PENTING: field ini adalah nilai string JSON, bukan teks LaTeX mentah. Setiap tanda backslash
  pada notasi LaTeX (mis. \\frac, \\times, \\pi, \\sqrt) HARUS ditulis dua kali di dalam JSON.
  Contoh yang benar: "\\\\frac{1}{2}". Contoh yang SALAH: "\\frac{1}{2}" (backslash tunggal akan
  diartikan sebagai escape character JSON seperti \\f atau \\t dan merusak notasi matematika).
- Kembalikan objek JSON dengan bentuk persis:
  { "correctLabel": "A"|"B"|"C"|"D", "answer": { "display_md": string, "machine": string }, "steps": string[] }`;

  return { system, prompt };
}
