import { seededShuffle } from "./seeded-shuffle";

interface Option {
  label: string;
  text_md: string;
}

interface Shufflable {
  options?: Option[];
  correctLabel?: string;
  stem_md?: string;
  explanation_md?: string;
  steps?: string[];
  answer?: { display_md?: string };
  verification_claims?: unknown[];
}

// "Semua jawaban benar", "Tidak ada jawaban yang benar", "Bukan salah satu di atas", "Semua salah"
// and the like only make sense as the last option, so they are never moved.
const PINNED_LAST = [
  /^\s*(?:semua|seluruh)(?:\s+(?:jawaban|pilihan|opsi))?(?:\s+di\s+atas)?\s+(?:benar|salah)\b/i,
  /^\s*tidak\s+ada(?:\s+(?:jawaban|pilihan|opsi))?(?:\s+yang)?\s+benar\b/i,
  /^\s*tidak\s+satu\s*pun\b/i,
  /^\s*bukan\s+salah\s+satu\b/i,
  /\bdi\s+atas\b/i,
];

const isPinned = (text: string) => PINNED_LAST.some((pattern) => pattern.test(text));

// The shuffle never rewrites text, so any place that might name an option by its letter makes the
// whole question stay as the model wrote it. A wrong explanation is worse than an unshuffled key.

const LETTER_UP = String.raw`\(?[A-E]\)?`;
const LETTER_ANY = String.raw`\(?[A-Ea-e]\)?`;
const SEPARATOR = String.raw`(?:\s*,\s*(?:(?:dan|atau|and)\s+)?|\s+(?:dan|atau|and)\s+|\s*&\s*)`;
const OPTION_WORD = "(?:[Jj]awaban|[Pp]ilihan|[Oo]psi|[Oo]ption|JAWABAN|PILIHAN|OPSI)";
// "pilihan A", "opsi (c)", "jawaban B dan C"
const WORD_THEN_LETTER = new RegExp(
  String.raw`\b${OPTION_WORD}\s+${LETTER_ANY}(?![\p{L}\p{N}])`,
  "u",
);
// "jawaban pertama", "pilihan yang kedua", "opsi terakhir"
const WORD_THEN_ORDINAL =
  /\b(?:jawaban|pilihan|opsi|option)\s+(?:yang\s+)?(?:pertama|kedua|ketiga|keempat|terakhir)\b/iu;
// "A-D", "A–D", "A sampai D"
const LETTER_RANGE =
  /(?<![\p{L}\p{N}])[A-E]\s*(?:[-–—]|sampai|hingga|s\.d\.)\s*[A-E](?![\p{L}\p{N}])/u;
// "A, B, C, atau D": three or more capital letters in a list (lowercase a, b, c are variables)
const LETTER_LIST = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${LETTER_UP}(?:${SEPARATOR}${LETTER_UP}){2,}(?![\p{L}\p{N}])`,
  "u",
);
// An option that is nothing but letters: "b dan c", "A, B, dan C", "A dan B benar", "C saja".
const OPTION_IS_LETTERS = new RegExp(
  String.raw`^\s*${LETTER_ANY}(?:${SEPARATOR}${LETTER_ANY})*\s*(?:benar|salah|saja)?\s*[.]?\s*$`,
  "iu",
);
// "Hanya B", "cuma (C)".
const ONLY_LETTER_OPTION = /(?:^|\s)(?:hanya|cuma)\s+\(?[A-E]\)?(?![\p{L}\p{N}])/iu;
// A lone letter in parentheses in explanation, steps or display: "(B)", "(b)". "B(4, 6)" and
// "f(a)" do not match.
const PAREN_LETTER = /(?<![\p{L}\p{N}])\([A-Ea-e]\)/u;

// "$A$", "$\text{B}$", "$\mathrm{C}$": a math span holding a single letter is that letter.
function unwrapLetterMath(text: string): string {
  return text.replace(
    /\$\s*(?:\\(?:text|mathrm|mathbf|textbf|mathit)\s*\{\s*)?([A-Ea-e])\s*\}?\s*\$/g,
    "$1",
  );
}

// Math is not prose: "$A + B$" is never an option reference.
function withoutMath(text: string): string {
  return text.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, " ");
}

const prose = (text: string) => withoutMath(unwrapLetterMath(text));

function mentionsOptionLetter(text: string): boolean {
  const t = prose(text);
  return (
    WORD_THEN_LETTER.test(t) ||
    WORD_THEN_ORDINAL.test(t) ||
    LETTER_RANGE.test(t) ||
    LETTER_LIST.test(t)
  );
}

function optionRefersToLetters(text: string): boolean {
  const t = prose(text);
  return (
    WORD_THEN_LETTER.test(t) ||
    WORD_THEN_ORDINAL.test(t) ||
    LETTER_RANGE.test(t) ||
    ONLY_LETTER_OPTION.test(t) ||
    OPTION_IS_LETTERS.test(unwrapLetterMath(text))
  );
}

const STANDALONE_LETTER = /(?<![\p{L}\p{N}_])\(?([A-D])\)?(?![\p{L}\p{N}_])/gu;
const ANSWER_WORD =
  /\b(?:jawab\p{L}*|pilihan|opsi|option|kunci|tepat|yang\s+benar|benar\s+adalah|salah|keliru|kesalahan|pengecoh|sesuai|cocok|yaitu|dipilih)\b/iu;
const PROXIMITY = 40;

// A letter that names a point, angle, side or shape is geometry, not an option: it directly
// follows a geometry word (also through a chain such as "titik A dan "), or is followed by "(" or
// "=" as in "A(1, 2)" and "A = 10".
const GEOMETRY_WORD = String.raw`(?:titik|sudut|sisi|segitiga|siku-siku\s+di|garis|ruas|bidang|persegi|jajargenjang|trapesium|panjang|luas|keliling)`;
const GEOMETRY_BEFORE = new RegExp(
  String.raw`\b${GEOMETRY_WORD}\s+(?:\p{L}{1,3}(?:\([^)]*\))?(?:\s*,\s*(?:dan\s+)?|\s+(?:dan|atau)\s+))*$`,
  "iu",
);

function isGeometryLetter(text: string, index: number, length: number): boolean {
  return (
    GEOMETRY_BEFORE.test(text.slice(0, index)) ||
    /^\s*[(=]/.test(text.slice(index + length))
  );
}

// A standalone A-D within about 40 characters of an answer word ("jawabannya adalah B"). "titik A
// dan B", "segitiga ABC", "sisi AB", "(A, B)" and "siku-siku di C" do not match.
function statesAnAnswerLetter(text: string): boolean {
  const t = prose(text);
  for (const match of t.matchAll(STANDALONE_LETTER)) {
    if (isGeometryLetter(t, match.index, match[0].length)) continue;
    const end = match.index + match[0].length;
    const window =
      t.slice(Math.max(0, match.index - PROXIMITY), match.index) +
      " " +
      t.slice(end, end + PROXIMITY);
    if (ANSWER_WORD.test(window)) return true;
  }
  return false;
}

function hasLabelLetter(text: string): boolean {
  const t = prose(text);
  if (PAREN_LETTER.test(t)) return true;
  for (const match of t.matchAll(STANDALONE_LETTER)) {
    if (!isGeometryLetter(t, match.index, match[0].length)) return true;
  }
  return false;
}

function mayReferenceLetters(question: Shufflable, options: Option[]): boolean {
  if (options.some((option) => optionRefersToLetters(option.text_md))) return true;
  const stem = question.stem_md;
  if (typeof stem === "string" && mentionsOptionLetter(stem)) return true;
  const worked = [question.explanation_md, ...(question.steps ?? [])].filter(
    (text): text is string => typeof text === "string",
  );
  for (const text of worked) {
    if (mentionsOptionLetter(text)) return true;
    if (PAREN_LETTER.test(prose(text))) return true;
    if (statesAnAnswerLetter(text)) return true;
  }
  const display = question.answer?.display_md;
  return typeof display === "string" && hasLabelLetter(display);
}

interface Claim {
  type?: string;
  options?: unknown;
  markedIndex?: unknown;
}

// A choice_matches_answer claim carries its own copy of the options; reorder it like the question
// so nothing disagrees later. markedIndex follows the option it marked.
function reorderClaim(claim: unknown, order: number[]): unknown {
  const c = claim as Claim | null;
  if (
    c?.type !== "choice_matches_answer" ||
    !Array.isArray(c.options) ||
    c.options.length !== order.length ||
    typeof c.markedIndex !== "number"
  ) {
    return claim;
  }
  const marked = order.indexOf(c.markedIndex);
  if (marked < 0) return claim;
  const options = c.options as unknown[];
  return { ...c, options: order.map((from) => options[from]), markedIndex: marked };
}

// Shuffles the options of a multiple-choice question and keeps the key on the same option text.
// Pure and deterministic for a given seed. Options are re-lettered A, B, C ... in the new order;
// "semua jawaban benar"-style options stay last in their original order. No text is rewritten:
// anything that is not a shufflable multiple-choice question (no options, fewer than two, an
// unknown key) or that may mention an option letter anywhere is returned as is.
export function shuffleQuestionOptions<Q extends Shufflable>(
  question: Q,
  seed: number,
): Q {
  const options = question.options;
  if (!Array.isArray(options) || options.length < 2) return question;
  if (!options.some((option) => option.label === question.correctLabel)) return question;
  if (mayReferenceLetters(question, options)) return question;

  const indexed = options.map((option, index) => ({ option, index }));
  const movable = indexed.filter((item) => !isPinned(item.option.text_md));
  const pinned = indexed.filter((item) => isPinned(item.option.text_md));
  const ordered = [...seededShuffle(movable, seed), ...pinned];

  const labelOf = (index: number) => String.fromCharCode(65 + index);
  const newLabel = new Map<string, string>();
  ordered.forEach((item, index) => newLabel.set(item.option.label, labelOf(index)));

  const result: Shufflable = {
    ...question,
    options: ordered.map((item, index) => ({ ...item.option, label: labelOf(index) })),
    correctLabel:
      question.correctLabel === undefined
        ? undefined
        : newLabel.get(question.correctLabel),
  };
  if (Array.isArray(question.verification_claims)) {
    const order = ordered.map((item) => item.index);
    result.verification_claims = question.verification_claims.map((claim) =>
      reorderClaim(claim, order),
    );
  }
  return result as Q;
}
