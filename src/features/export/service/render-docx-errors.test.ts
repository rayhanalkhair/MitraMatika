// Typed failures of the Word renderer: what reaches the export job is a RenderDocxError with a
// fixed message (the detail stays in `cause`), and only a typed formula failure becomes a warning.
import { createCanvas } from "@napi-rs/canvas";
import { Packer } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderDocxError as ExportedError, type RenderDocxErrorCode } from "..";
import { snapshot, template, version } from "../test-support";
import { buildDocumentModel } from "./document-model";
import { LatexToOmmlError } from "./latex-to-omml";
import { RenderDocxError, renderDocxDocument } from "./render-docx";

const imageFailure = vi.hoisted(() => ({ on: false }));
vi.mock("docx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("docx")>();
  class ImageRun extends actual.ImageRun {
    constructor(options: ConstructorParameters<typeof actual.ImageRun>[0]) {
      if (imageFailure.on) throw new Error("/srv/app/logo.png: bad image");
      super(options);
    }
  }
  return { ...actual, ImageRun };
});

const formulaHook = vi.hoisted(() => ({
  fail: null as ((latex: string) => void) | null,
}));
vi.mock("./latex-to-omml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./latex-to-omml")>();
  return {
    ...actual,
    latexToOmml: (latex: string) => {
      formulaHook.fail?.(latex);
      return actual.latexToOmml(latex);
    },
  };
});

const A4 = { paper: "A4", font: "times" } as const;
const doc = (stem = "Soal $x^2$") =>
  buildDocumentModel(snapshot({}, { i1: version(stem) }), template);

afterEach(() => {
  vi.restoreAllMocks();
  imageFailure.on = false;
  formulaHook.fail = null;
});

describe("RenderDocxError", () => {
  it("is exported from the export feature with its codes and fixed messages", () => {
    expect(ExportedError).toBe(RenderDocxError);
    const codes: RenderDocxErrorCode[] = ["render", "pack", "image"];
    const messages = codes.map((code) => new RenderDocxError(code).message);
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) expect(message).toMatch(/^Word renderer: /);
  });
});

describe("renderDocxDocument failures", () => {
  it("wraps a packer failure as 'pack' without leaking its message", async () => {
    const cause = new Error("/tmp/secret/path: EACCES");
    vi.spyOn(Packer, "toBuffer").mockRejectedValue(cause);
    const error: unknown = await renderDocxDocument(doc(), "paper", A4).then(
      () => expect.unreachable(),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RenderDocxError);
    expect((error as RenderDocxError).code).toBe("pack");
    expect((error as Error).message).not.toContain("/tmp");
    expect((error as Error).cause).toBe(cause);
  });

  it("wraps a logo that docx cannot embed as 'image'", async () => {
    imageFailure.on = true;
    const logo = {
      bytes: new Uint8Array(createCanvas(20, 10).toBuffer("image/png")),
      contentType: "image/png",
    };
    const withLogo = buildDocumentModel(snapshot(), template, { logo });
    const error: unknown = await renderDocxDocument(withLogo, "paper", A4).then(
      () => expect.unreachable(),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RenderDocxError);
    expect((error as RenderDocxError).code).toBe("image");
    expect((error as Error).message).not.toContain("/srv");
  });

  it("turns only a typed formula failure into a warning", async () => {
    formulaHook.fail = (latex) => {
      if (latex === "\\typed") throw new LatexToOmmlError("parse");
    };
    const { warnings } = await renderDocxDocument(doc("Soal $\\typed$"), "paper", A4);
    expect(warnings).toEqual([
      { code: "mathFailed", where: { part: "stem", number: 1 }, source: "\\typed" },
    ]);
  });

  it("lets any other error in a formula fail the render as 'render'", async () => {
    const bug = new TypeError("cannot read properties of undefined");
    formulaHook.fail = (latex) => {
      if (latex === "\\bug") throw bug;
    };
    const error: unknown = await renderDocxDocument(
      doc("Soal $\\bug$"),
      "paper",
      A4,
    ).then(
      () => expect.unreachable(),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RenderDocxError);
    expect((error as RenderDocxError).code).toBe("render");
    expect((error as Error).cause).toBe(bug);
  });
});
