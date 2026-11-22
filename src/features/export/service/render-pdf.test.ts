// renderPdf on React-PDF: caps, timeout, typed errors and isolation. The renders are real (no
// binary needed); only the failure tests replace renderToBuffer.
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Document, Image, Page } from "@react-pdf/renderer";
import { cloneElement, createElement, type ReactElement } from "react";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPaper } from "../test-fixtures/pdf-cap-docs";
import { snapshot, template, version } from "../test-support";
import { buildDocumentModel, type ExportDocument } from "./document-model";
import { createMathCache } from "./pdf/math-box";
import {
  confirmedPages,
  countPdfPages,
  documentSize,
  layoutPageCount,
  MAX_FORMULA_CHARS,
  MAX_FORMULAS,
  MAX_SOURCE_CHARS,
  PDF_TIMEOUT_MS,
  renderPdf,
  RenderPdfError,
} from "./render-pdf";

type Rendering = ReactElement<{ onRender: (data: unknown) => void }>;
const renderer = vi.hoisted(() => ({
  render: null as null | ((element: Rendering) => Promise<Buffer>),
  calls: 0,
}));
vi.mock("@react-pdf/renderer", async (original) => {
  const actual = await original<typeof import("@react-pdf/renderer")>();
  return {
    // The module namespace is spread to keep every other export (Font, Document ...) as it is.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    ...actual,
    renderToBuffer: (element: Parameters<typeof actual.renderToBuffer>[0]) => {
      renderer.calls += 1;
      return renderer.render
        ? renderer.render(element as Rendering)
        : actual.renderToBuffer(element);
    },
  };
});

const actualRenderer = () =>
  vi.importActual<typeof import("@react-pdf/renderer")>("@react-pdf/renderer");

const SLOW = 60_000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  renderer.render = null;
  renderer.calls = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One section with an item per stem (options and steps as `version` makes them). */
function model(
  stems: string[],
  overrides: Partial<ReturnType<typeof version>> = {},
): ExportDocument {
  const base = snapshot();
  const versions = new Map<string, ReturnType<typeof version>>();
  const items = stems.map((stem, index) => {
    const id = `r${String(index)}`;
    versions.set(`v-${id}`, version(stem, "B", overrides));
    return {
      ...base.sections[0].items[0],
      itemId: id,
      questionId: `q-${id}`,
      versionId: `v-${id}`,
    };
  });
  return buildDocumentModel(
    snapshot({ sections: [{ ...base.sections[0], items }], versions }),
    template,
  );
}

const plain = () => buildDocumentModel(snapshot(), template);

describe("renderPdf", () => {
  it(
    "prints a PDF for each kind, with the page count of the file",
    async () => {
      const doc = plain();
      for (const kind of ["paper", "key", "solutions"] as const) {
        const result = await renderPdf(doc, kind);
        expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
        expect(result.pages).toBe(countPdfPages(result.bytes));
        expect(result.pages).toBeGreaterThan(0);
        expect(result.warnings).toEqual([]);
      }
    },
    SLOW,
  );

  it(
    "returns the warnings of the render and shares a given formula cache",
    async () => {
      const doc = model([String.raw`Hitung $\foo{x}$ dan $\frac{1}{2}$`]);
      const math = createMathCache();
      const result = await renderPdf(doc, "paper", { math });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "mathFailed",
          source: String.raw`\foo{x}`,
        }),
      ]);
      // The same cache serves the next render: the formula is already typeset.
      expect(math(String.raw`\frac{1}{2}`, false)).toBe(
        math(String.raw`\frac{1}{2}`, false),
      );
    },
    SLOW,
  );

  it("counts pages from the page objects, not the page tree", () => {
    const bytes = new TextEncoder().encode(
      "<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>",
    );
    expect(countPdfPages(bytes)).toBe(2);
    expect(countPdfPages(new TextEncoder().encode("%PDF-1.7\n%%EOF"))).toBe(0);
  });
});

/** A small document that prints something in every field `documentSize` counts. */
function handBuilt(): ExportDocument {
  const options = (["A", "B", "C", "D"] as const).map((label) => ({
    label,
    textMd: label === "B" ? "ob $c$" : `o${label.toLowerCase()}`,
  }));
  return {
    meta: {
      title: "Ujian",
      kindLabel: "Ulangan",
      grade: 7,
      examDate: "Selasa",
      durationMinutes: 90,
      instructionsMd: "Petunjuk $a$",
      subject: "Mat",
    },
    header: { schoolName: "SMP", lines: ["L1", "L22"], logoDataUri: null },
    studentFields: [{ key: "name", label: "Nama" }],
    sections: [
      {
        title: "Bagian A",
        instructionsMd: "Sec $b$",
        items: [
          {
            itemId: "i1",
            number: 1,
            stemMd: "Stem $x^2$",
            options,
            columns: 1,
            points: 1,
            answerMd: "B",
            steps: ["s1 $d$", "s2"],
          },
        ],
      },
    ],
    page: { paper: "A4", font: "times" },
  };
}

describe("caps", () => {
  it("counts exactly what each kind prints", () => {
    const doc = handBuilt();
    // Printed by every kind: title 5, subject 3, date 6, school 3, header lines 2 + 3,
    // student label 4, section title 8 = 34.
    // Paper: exam instructions 12, section instructions 7, stem 10, options 2 + 6 + 2 + 2.
    expect(documentSize(doc, "paper")).toEqual({
      chars: 34 + 12 + 7 + 10 + 12,
      formulas: 4,
      formulaChars: 1 + 1 + 3 + 1,
    });
    // Solutions: stem 10, the correct option 6, steps 6 + 2.
    expect(documentSize(doc, "solutions")).toEqual({
      chars: 34 + 10 + 6 + 6 + 2,
      formulas: 3,
      formulaChars: 3 + 1 + 1,
    });
    // Key: the answer letter.
    expect(documentSize(doc, "key")).toEqual({
      chars: 34 + 1,
      formulas: 0,
      formulaChars: 0,
    });
  });

  it("stops summing once over the character cap, before parsing the rest", () => {
    const doc = handBuilt();
    doc.sections[0].items[0].stemMd = "x".repeat(MAX_SOURCE_CHARS + 1);
    const size = documentSize(doc, "paper");
    expect(size.chars).toBeGreaterThan(MAX_SOURCE_CHARS);
    expect(size.formulas).toBeLessThan(4);
  });

  it("accepts exactly MAX_SOURCE_CHARS and refuses one more", async () => {
    const stem = (n: number) => "ab ".repeat(Math.floor(n / 3)) + "c".repeat(n % 3);
    const base = documentSize(model([""]), "paper").chars;
    const exact = model([stem(MAX_SOURCE_CHARS - base)]);
    expect(documentSize(exact, "paper").chars).toBe(MAX_SOURCE_CHARS);
    const over = model([stem(MAX_SOURCE_CHARS - base + 1)]);
    expect(documentSize(over, "paper").chars).toBe(MAX_SOURCE_CHARS + 1);
    await expect(renderPdf(over, "paper")).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("refuses too many characters before any layout", async () => {
    const doc = model(["x".repeat(MAX_SOURCE_CHARS + 1)]);
    const error = await renderPdf(doc, "paper").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "RenderPdfError", code: "tooLarge" });
    expect((error as Error).message).toBe(
      "PDF renderer: the document is too large to print",
    );
    expect(renderer.calls).toBe(0);
  });

  it("refuses too many formulas before any layout", async () => {
    const doc = model(["$x$ ".repeat(MAX_FORMULAS + 1)]);
    await expect(renderPdf(doc, "paper")).rejects.toMatchObject({ code: "tooLarge" });
    expect(renderer.calls).toBe(0);
  });

  it("refuses too many characters inside formulas before any layout", async () => {
    const doc = model([`$${"x+".repeat(MAX_FORMULA_CHARS / 2)}x$`]);
    expect(documentSize(doc, "paper").formulaChars).toBeGreaterThan(MAX_FORMULA_CHARS);
    await expect(renderPdf(doc, "paper")).rejects.toMatchObject({ code: "tooLarge" });
    expect(renderer.calls).toBe(0);
  });

  it(
    "accepts a document exactly at the formula cap",
    async () => {
      const doc = model([Array.from({ length: MAX_FORMULAS }, () => "$x$").join(" ")]);
      expect(documentSize(doc, "paper").formulas).toBe(MAX_FORMULAS);
      await expect(renderPdf(doc, "paper", { timeoutMs: 50_000 })).resolves.toMatchObject(
        {
          pages: expect.any(Number) as number,
        },
      );
    },
    SLOW,
  );

  it(
    "lets a realistic paper through: 40 items x 3 formulas, solutions with a formula in each of 5 steps",
    async () => {
      const stem = String.raw`Harga $x+3$ rupiah dan $\frac{x}{2}$ rupiah, luas $24 \text{ cm}^2$ dipakai oleh toko untuk menghitung belanja.`;
      const doc = model(
        Array.from({ length: 40 }, () => stem),
        {
          steps: Array.from(
            { length: 5 },
            (_, k) => String.raw`Langkah ${String(k)}: $a_${String(k)}=2x+1$.`,
          ),
        },
      );
      for (const kind of ["paper", "solutions"] as const) {
        const size = documentSize(doc, kind);
        expect(size.formulas, kind).toBeLessThan(MAX_FORMULAS);
        expect(size.chars, kind).toBeLessThan(MAX_SOURCE_CHARS);
        expect(size.formulaChars, kind).toBeLessThan(MAX_FORMULA_CHARS / 2);
      }
      const solutions = await renderPdf(doc, "solutions", { timeoutMs: 50_000 });
      expect(solutions.pages).toBeGreaterThan(5);
      expect(solutions.pages).toBeLessThan(100);
    },
    SLOW,
  );

  it(
    "renders the heaviest allowed shape: 4 x 4 matrices up to the formula-character cap",
    async () => {
      // Calibration (render-pdf-calibration.test.ts): about 680 MB peak RSS including the
      // Vitest baseline, 3.6 s. 137 formula characters per matrix formula.
      const formulas = Math.floor(MAX_FORMULA_CHARS / 137);
      const doc = matrixPaper(formulas);
      const size = documentSize(doc, "paper");
      expect(size.formulaChars).toBeLessThanOrEqual(MAX_FORMULA_CHARS);
      expect(size.formulaChars).toBeGreaterThan(MAX_FORMULA_CHARS - 300);
      expect(size.formulas).toBeLessThanOrEqual(MAX_FORMULAS);
      expect(size.chars).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
      const started = performance.now();
      const result = await renderPdf(doc, "paper");
      expect(performance.now() - started).toBeLessThan(PDF_TIMEOUT_MS / 2);
      expect(result.pages).toBeLessThan(100);
      expect(result.warnings).toEqual([]);
      // Peak RSS of this test process (every earlier test included), with a wide margin over the
      // 680 MB measured, so only a large regression fails.
      expect(process.resourceUsage().maxRSS / 1024).toBeLessThan(1200);
    },
    SLOW,
  );
});

describe("page count", () => {
  it("trusts the file when the layout agrees or says nothing", () => {
    expect(confirmedPages(3, 3)).toBe(3);
    expect(confirmedPages(3, null)).toBe(3);
  });

  it("refuses a disagreement and a file with no page", () => {
    expect(() => confirmedPages(3, 2)).toThrow("page count mismatch");
    expect(() => confirmedPages(0, null)).toThrow("page count mismatch");
    expect(() => confirmedPages(0, 0)).toThrow("page count mismatch");
  });

  it("reads the layout's page list defensively", () => {
    expect(layoutPageCount({ _INTERNAL__LAYOUT__DATA_: { children: [1, 2, 3] } })).toBe(
      3,
    );
    expect(layoutPageCount({})).toBeNull();
    expect(layoutPageCount({ _INTERNAL__LAYOUT__DATA_: {} })).toBeNull();
    expect(layoutPageCount({ _INTERNAL__LAYOUT__DATA_: { children: "x" } })).toBeNull();
    expect(layoutPageCount(undefined)).toBeNull();
  });

  it(
    "React-PDF still reports its layout, and it agrees with the file",
    async () => {
      // A version bump that renames the internal field turns the cross-check into a no-op:
      // this test fails instead.
      let reported: unknown = null;
      renderer.render = async (element) => {
        const real = await actualRenderer();
        const wrapped = cloneElement(element, {
          onRender: (data: unknown) => {
            reported = data;
            element.props.onRender(data);
          },
        });
        return real.renderToBuffer(wrapped);
      };
      const result = await renderPdf(plain(), "paper");
      expect(layoutPageCount(reported)).toBe(result.pages);
      expect(result.pages).toBe(1);
    },
    SLOW,
  );

  it(
    "rejects as render when the layout says another page count than the file",
    async () => {
      renderer.render = async (element) => {
        const real = await actualRenderer();
        const bytes = await real.renderToBuffer(element);
        element.props.onRender({ _INTERNAL__LAYOUT__DATA_: { children: [1, 2, 3] } });
        return bytes;
      };
      await expect(renderPdf(plain(), "paper")).rejects.toMatchObject({ code: "render" });
    },
    SLOW,
  );

  it("refuses a file whose page count cannot be trusted", async () => {
    renderer.render = () => Promise.resolve(Buffer.from("%PDF-1.7 no pages"));
    await expect(renderPdf(plain(), "paper")).rejects.toMatchObject({ code: "render" });
  });
});

describe("time and failures", () => {
  it(
    "counts a render that overran as a timeout even when its bytes are ready",
    async () => {
      const error = await renderPdf(plain(), "paper", { timeoutMs: 1 }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ name: "RenderPdfError", code: "timeout" });
      expect((error as Error).message).toBe(
        "PDF renderer: the render did not finish in time",
      );
      await delay(500);
    },
    SLOW,
  );

  it("gives up on a slow render at the timer, without waiting for it", async () => {
    renderer.render = async () => {
      await delay(400);
      return Buffer.from("%PDF-1.7 /Type /Page");
    };
    const started = performance.now();
    await expect(renderPdf(plain(), "paper", { timeoutMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(performance.now() - started).toBeLessThan(300);
    await delay(500);
  });

  it("does not leak a failure of the render that lost the race", async () => {
    renderer.render = async () => {
      await delay(100);
      throw new Error("late failure");
    };
    await expect(renderPdf(plain(), "paper", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
    // Vitest fails the run on an unhandled rejection: waiting is the assertion.
    await delay(300);
  });

  it("keeps the next render waiting until a timed-out one has finished", async () => {
    let firstEnded = 0;
    let secondStarted = 0;
    renderer.render = async () => {
      await delay(300);
      firstEnded = performance.now();
      return Buffer.from("%PDF-1.7 /Type /Page");
    };
    await expect(renderPdf(plain(), "paper", { timeoutMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
    renderer.render = () => {
      secondStarted = performance.now();
      return Promise.resolve(Buffer.from("%PDF-1.7 /Type /Page"));
    };
    await renderPdf(plain(), "paper", { timeoutMs: 5_000 });
    expect(firstEnded).toBeGreaterThan(0);
    expect(secondStarted).toBeGreaterThanOrEqual(firstEnded);
  });

  it("does not wait for a stuck render longer than its own timeout", async () => {
    renderer.render = () => delay(600).then(() => Buffer.from("%PDF-1.7 /Type /Page"));
    await expect(renderPdf(plain(), "paper", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
    const started = performance.now();
    await expect(renderPdf(plain(), "paper", { timeoutMs: 40 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(performance.now() - started).toBeLessThan(400);
    await delay(700);
  });

  it("turns a renderer failure into render: fixed message, cause kept, no document text", async () => {
    const secret = "SOAL-RAHASIA-12345";
    const failure = new Error(`boom ${secret}`);
    renderer.render = () => Promise.reject(failure);
    const error = await renderPdf(model([secret]), "paper").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderPdfError);
    const typed = error as RenderPdfError;
    expect(typed.code).toBe("render");
    expect(typed.message).toBe("PDF renderer: the document could not be printed");
    expect(typed.message).not.toContain(secret);
    expect(typed.cause).toBe(failure);
  });

  it("turns a failure while building the tree into render", async () => {
    const broken = { ...plain(), sections: null } as unknown as ExportDocument;
    await expect(renderPdf(broken, "paper")).rejects.toMatchObject({ code: "render" });
  });
});

// A document that tries every way to reach out or confuse the layout. Nothing may touch the
// network (the stubs throw and count), nothing is interpreted as markup, nothing throws.
const HOSTILE = [
  "<script>alert(1)</script> <img src=http://127.0.0.1:9/x> @import url(http://x)",
  "![x](http://example.com/a.png) et [y](http://example.com/b)",
  String.raw`Rumus $\href{http://x}{y}$ dan $\includegraphics{http://x/a.png}$ lalu $\frac{1}{2}$`,
  "Emoji \u{1F600} \u{1F468}‍\u{1F469}‍\u{1F467} Arab مرحبا ZWJ a‍b",
  `Kontrol ${Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("")} selesai`,
  "Surrogat \uD800 dan \uDC00 lalu selesai",
  "K".repeat(300),
];

/** Every way out of the process that this test knows about throws and is counted. */
function stubNetwork() {
  const blocked = vi.fn((name: string) => {
    throw new Error(`network call blocked: ${name}`);
  });
  // yoga-layout starts its WebAssembly with fetch(<data: URI>) on the first render in a
  // process: that is no network, so data: URIs go to the real fetch.
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("data:")) return realFetch(input, init);
      return blocked("fetch");
    }),
  );
  const surfaces: [string, object, string[]][] = [
    ["http", http, ["request", "get"]],
    ["https", https, ["request", "get"]],
    ["http2", http2, ["connect"]],
    ["net", net, ["connect", "createConnection"]],
    ["net.Socket", net.Socket.prototype, ["connect"]],
    ["tls", tls, ["connect"]],
    ["dns", dns, ["lookup", "resolve"]],
  ];
  for (const [label, target, names] of surfaces) {
    for (const name of names) {
      vi.spyOn(target as Record<string, () => never>, name).mockImplementation(() =>
        blocked(`${label}.${name}`),
      );
    }
  }
  return blocked;
}

describe("isolation", () => {
  it("has stubs that trip: a fetch of a URL and a socket are caught", () => {
    const blocked = stubNetwork();
    expect(() => fetch("http://example.invalid/a.png")).toThrow("network call blocked");
    expect(() => net.connect(9, "127.0.0.1")).toThrow("network call blocked");
    expect(() => {
      dns.lookup("example.invalid", () => undefined);
    }).toThrow("network call blocked");
    expect(blocked).toHaveBeenCalledTimes(3);
  });

  it(
    "would notice React-PDF being handed a URL (control for the hostile test)",
    async () => {
      const blocked = stubNetwork();
      const real = await actualRenderer();
      const tree = createElement(
        Document,
        null,
        createElement(
          Page,
          { size: "A4" },
          createElement(Image, { src: "http://example.invalid/a.png" }),
        ),
      );
      await real.renderToBuffer(tree).catch(() => undefined);
      expect(blocked).toHaveBeenCalled();
    },
    SLOW,
  );

  it(
    "renders a hostile document with every network entry point stubbed to throw",
    async () => {
      const blocked = stubNetwork();
      const doc = model(HOSTILE);
      const result = await renderPdf(doc, "paper");
      expect(blocked).not.toHaveBeenCalled();
      expect(result.pages).toBeGreaterThan(0);
      // The formulas KaTeX refuses are warnings on the PDF, the render goes on.
      expect(result.warnings.map((w) => w.code)).toEqual(
        expect.arrayContaining(["mathFailed"]),
      );

      const { text } = await extractText(await getDocumentProxy(result.bytes.slice()), {
        mergePages: true,
      });
      // Markup is printed, never interpreted.
      expect(text).toContain("<script>alert(1)</script>");
      expect(text).toContain("@import");
      expect(text).toContain("![x](http://example.com/a.png)");
      expect(text).toContain("selesai");
    },
    SLOW,
  );
});
