import { describe, expect, it } from "vitest";
import enMessages from "../../../messages/en.json";
import idMessages from "../../../messages/id.json";

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

// The names of the ICU arguments of a message: `{name}`, `{name, number}`, `{name, plural, ...}`,
// `{name, select, ...}` and the arguments nested in plural/select branches. Text between
// apostrophes is an ICU literal and is skipped.
export function icuArguments(message: string): string[] {
  const names = new Set<string>();
  const scan = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'") {
        const close = text.indexOf("'", i + 1);
        i = close === -1 ? text.length : close + 1;
      } else if (ch === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === "{") depth += 1;
          else if (text[j] === "}") depth -= 1;
          j += 1;
        }
        const body = text.slice(i + 1, j - 1);
        const name = /^\s*([^\s,}]+)/.exec(body)?.[1];
        if (name) names.add(name);
        const comma = body.indexOf(",");
        if (comma !== -1) {
          const rest = body.slice(comma + 1);
          if (/^\s*(plural|select|selectordinal)\s*,/.test(rest)) {
            // Each `selector {branch}` pair: the branch text is a message of its own.
            let k = rest.indexOf("{");
            while (k !== -1) {
              let branchDepth = 1;
              let m = k + 1;
              while (m < rest.length && branchDepth > 0) {
                if (rest[m] === "{") branchDepth += 1;
                else if (rest[m] === "}") branchDepth -= 1;
                m += 1;
              }
              scan(rest.slice(k + 1, m - 1));
              k = rest.indexOf("{", m);
            }
          }
        }
        i = j;
      } else {
        i += 1;
      }
    }
  };
  scan(message);
  return [...names].sort();
}

const id = flatten(idMessages);
const en = flatten(enMessages);

describe("icuArguments", () => {
  it("extracts plain, formatted and nested arguments", () => {
    expect(icuArguments("Halo")).toEqual([]);
    expect(icuArguments("{a} dan {b}")).toEqual(["a", "b"]);
    expect(icuArguments("{n, number} item")).toEqual(["n"]);
    expect(icuArguments("{n, plural, one {# {thing}} other {# things}}")).toEqual([
      "n",
      "thing",
    ]);
    expect(icuArguments("'{literal}' {x}")).toEqual(["x"]);
  });
});

describe("message catalogs", () => {
  it("has exactly the same keys in id.json and en.json", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
  });

  it("has no empty message", () => {
    for (const [key, value] of [...Object.entries(id), ...Object.entries(en)]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("uses the same ICU argument names in every id/en pair", () => {
    for (const key of Object.keys(id)) {
      expect(icuArguments(en[key]), key).toEqual(icuArguments(id[key]));
    }
  });

  it("has the 22 argument-taking messages the old copy functions became, plus 3 account emails, the resend countdown and the account-deletion prompt and the daily limit, and 7 for the bank filters (page range, page label, grade, remove, three pills), and 7 for the question editor (choice text, key choice, the step limit hint, step label, and the remove, up and down labels of a step), and 4 for regeneration (hint length, daily limit, two version labels), and 1 for the history version label, and 6 for the trash (deleted date, days left, two button labels, version count, move label), and 4 for the document templates (make default, edit, header line number, preview subject), and 24 for the assessment builder (counts, dates, grade, template name, item numbers and versions, picker heading, result and paging, the new-questions offer), and 10 for scoring and approval (point label, scaled share, total, problem count, approval date, four item problems, the total problem), and 4 for the document preview (where a formula failed: question text, option, step, section), and 4 for the export panel (expiry date, download label, warning item, hourly limit), and 13 for the assessment and template trash (summary, two button labels each, three confirmation counts, in use by, two move labels, two in-use refusals, the pinned-question note), and 7 for the material upload (storage meter, uploading, checking, done, failed, cancelled, progress label), and 23 for the materials library (page count, grade, match page, folder, paging summary, page label, folder count, folder place, text-quality summary, pages to check, confirmation date, five chapter field labels, two material and two folder trash labels, chapter count, two move labels), and 1 for the structure proposal limit, and 3 for the structure editor (a chapter with a bad value, a chapter past the last page, the chapter limit), and 10 for OCR and page review (page of total, page image label, page text label, marked parts, text too long, pages left today, page checkbox, preparing progress, pages queued, too many pages), and 2 for OCR refusals (blank pages, overwriting a correction), and 4 for material sources (chapter page range, page list hint, source label, source without a page), and 13 for the solver (solves left, character count, chosen photo, upload progress, three refusals with limits, two uncertain-reading items, method, rounding, step count, step label, the disagreeing cross-check), and 3 for the solver trash (two button labels, solution count), and 3 for the shared vision cap (two counters left, the refusal), and 1 for the waiting page (the account line), and 2 for the admin notice and digest emails", () => {
    const withArguments = Object.entries(id).filter(
      ([, v]) => icuArguments(v).length > 0,
    );
    expect(withArguments).toHaveLength(186);
  });

  it("has the auth error keys the auth module maps to", () => {
    expect(Object.keys(idMessages.auth.errors).sort()).toEqual([
      "generic",
      "oauthDenied",
      "unauthenticated",
    ]);
  });

  it("never calls a machine verdict benar anywhere in the Indonesian review, bank or beranda copy", () => {
    // "kebenaran" (in the disclaimer) is a different word and is allowed. The one exception is the
    // teacher's own confirmation sentence (Q7): the teacher, not the machine, vouches for the key.
    const allowed = idMessages.review.decision.overrideConfirm;
    expect(allowed).toBe("Saya sudah memeriksa; kunci jawaban benar");
    const strings = Object.entries(id)
      .filter(([key]) => /^(review|bank|beranda)\./.test(key))
      .map(([, value]) => value);
    expect(strings.length).toBeGreaterThan(30);
    expect(strings.filter((text) => /\bbenar\b/i.test(text))).toEqual([allowed]);
  });

  it("keeps the copy rules: no 'successfully', no 'please', no exclamation mark", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toMatch(/successfully|please /i);
      expect(value, key).not.toContain("!");
    }
    for (const [key, value] of Object.entries(id)) {
      expect(value, key).not.toContain("!");
    }
  });

  it("writes the English catalog in sentence case", () => {
    // Only the curriculum name and the Times New Roman font name are exempt; the product name MitraMatika is a single word.
    const strip = (text: string): string =>
      text.replace(/Kurikulum Merdeka|Times New Roman/g, "x").replace(/\{[^}]*\}/g, "x");
    for (const [key, value] of Object.entries(en)) {
      const text = strip(value);
      expect(/\b[A-Z][a-z]+\b(?:\s+[A-Z][a-z]+\b)+/.test(text), `${key}: ${value}`).toBe(
        false,
      );
      // ALL CAPS words, except roman numerals (grade levels), the SPLDV acronym and the logo file
      // formats, the export formats, the material formats and OCR.
      const caps = (text.match(/\b[A-Z]{3,}\b/g) ?? []).filter(
        (word) =>
          !/^[IVX]+$/.test(word) &&
          !["SPLDV", "PNG", "JPG", "SVG", "PDF", "ZIP", "DOCX", "OCR"].includes(word),
      );
      expect(caps, key).toEqual([]);
    }
  });

  it("keeps English labels in fixed-width spots within 1.6x of the Indonesian ones", () => {
    const fixed = Object.keys(id).filter((key) => key.startsWith("nav."));
    expect(fixed.length).toBeGreaterThan(5);
    for (const key of fixed) {
      expect(
        en[key].length / id[key].length,
        `${key}: ${en[key]} / ${id[key]}`,
      ).toBeLessThanOrEqual(1.6);
    }
  });
});
