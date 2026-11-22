// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import {
  snapshot,
  template as templateFixture,
  version,
} from "@/features/export/test-support";

const ID = "5f0f5c2e-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
const mocks = vi.hoisted(() => ({
  requireAllowedUser: vi.fn(),
  runAsUser: vi.fn(),
  loadExportSnapshot: vi.fn(),
  getTemplate: vi.fn(),
  readLogo: vi.fn(),
  getApprovalState: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/features/auth", () => ({ requireAllowedUser: mocks.requireAllowedUser }));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/db/client", () => ({ runAsUser: mocks.runAsUser }));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => ({ store: true }) }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/features/export", async () => ({
  ...(await vi.importActual<object>("@/features/export")),
  loadExportSnapshot: mocks.loadExportSnapshot,
}));
vi.mock("@/features/templates", async () => ({
  ...(await vi.importActual<object>("@/features/templates")),
  getTemplate: mocks.getTemplate,
  readLogo: mocks.readLogo,
}));
vi.mock("@/features/assessments", async () => ({
  ...(await vi.importActual<object>("@/features/assessments")),
  getApprovalState: mocks.getApprovalState,
}));

import { logger } from "@/lib/logger";
import { setTestLocale } from "@/test/intl-server";
import AssessmentPreviewPage from "./page";

const okSnapshot = (data: ReturnType<typeof snapshot>) => ({ ok: true, data });
const render = async (searchParams: Record<string, string> = {}, id = ID) =>
  renderWithIntl(
    await AssessmentPreviewPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
const frame = () => {
  const element = document.querySelector("iframe");
  if (!element) throw new Error("no iframe");
  return element;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAllowedUser.mockResolvedValue({ status: "allowed", userId: "user-1" });
  mocks.runAsUser.mockImplementation((_db, _user, fn: (tx: unknown) => unknown) =>
    fn({ tx: true }),
  );
  mocks.loadExportSnapshot.mockResolvedValue(okSnapshot(snapshot()));
  mocks.getTemplate.mockResolvedValue({ ok: true, data: templateFixture });
  mocks.getApprovalState.mockResolvedValue({ approved: false });
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});
afterEach(() => {
  cleanup();
  setTestLocale("id");
});

describe("assessment preview page", () => {
  it("shows the paper in a sandboxed iframe with no script permissions", async () => {
    await render();
    const element = frame();
    expect(element.hasAttribute("sandbox")).toBe(true);
    expect(element.getAttribute("sandbox")).toBe("");
    expect(element.getAttribute("srcdoc")).toContain("Naskah Soal");
    expect(element.getAttribute("srcdoc")).toContain("Soal i1");
    expect(element.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(element.getAttribute("src")).toBeNull();
  });

  it("switches the document by the kind query and defaults to the paper", async () => {
    await render({ kind: "key" });
    expect(frame().getAttribute("srcdoc")).toContain("Kunci Jawaban");
    cleanup();
    await render({ kind: "solutions" });
    expect(frame().getAttribute("srcdoc")).toContain("Langkah satu.");
    cleanup();
    await render({ kind: "<script>" });
    expect(frame().getAttribute("srcdoc")).toContain("Naskah Soal");
    const links = screen.getAllByRole("link");
    expect(
      links.find((l) => l.getAttribute("aria-current") === "page")?.textContent,
    ).toBe("Naskah soal");
  });

  it("reads under RLS as the signed-in teacher and names the owner", async () => {
    await render();
    expect(mocks.runAsUser).toHaveBeenCalledWith(
      { db: true },
      "user-1",
      expect.any(Function),
    );
    expect(mocks.loadExportSnapshot).toHaveBeenCalledWith(
      { tx: true },
      { ownerId: "user-1", assessmentId: ID },
    );
  });

  it("is not found for an unknown or foreign assessment and a malformed id", async () => {
    mocks.loadExportSnapshot.mockResolvedValue({ ok: false, error: "notFound" });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render({}, "nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists formulas that fell back to plain text", async () => {
    mocks.loadExportSnapshot.mockResolvedValue(
      okSnapshot(snapshot({}, { i1: version("Hitung $\\frac{1}{$") })),
    );
    await render();
    expect(screen.getByRole("status").textContent).toContain("Soal 1: teks soal");
  });

  it("lists a formula too wide for the page under its own heading (I7)", async () => {
    const tooWide = Array.from({ length: 40 }, (_, i) => `a_{${String(i)}}`).join(" + ");
    mocks.loadExportSnapshot.mockResolvedValue(
      okSnapshot(snapshot({}, { i1: version(`Hitung\n\n$$${tooWide}$$`) })),
    );
    await render();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Ada rumus yang terlalu lebar untuk halaman");
    expect(status.textContent).toContain("Soal 1: teks soal");
    expect(screen.queryByText("Ada rumus yang tidak dapat ditampilkan")).toBeNull();
  });

  it("translates the formula locations in English too", async () => {
    mocks.loadExportSnapshot.mockResolvedValue(
      okSnapshot(
        snapshot(
          { instructionsMd: "Lihat $\\frac{1}{$" },
          {
            i1: version("Hitung $\\frac{1}{$", "B", {
              options: [
                { label: "B", textMd: "$\\bad$" },
                { label: "A", textMd: "x" },
              ],
              steps: ["ok", "$\\frac{$"],
            }),
          },
        ),
      ),
    );
    setTestLocale("en");
    await render({ kind: "solutions" });
    const text = screen.getByRole("status").textContent;
    expect(text).toContain("Question 1: question text");
    expect(text).toContain("Question 1: option B");
    expect(text).toContain("Question 1: step 2");
    cleanup();
    await render();
    expect(screen.getByRole("status").textContent).toContain("General instructions");
    expect(screen.getByRole("status").textContent).not.toMatch(
      /soal|pilihan|langkah|petunjuk/i,
    );
    expect(text).not.toMatch(/soal|pilihan|langkah|petunjuk/i);
  });

  it("explains a trashed or missing template instead of silently dropping the letterhead", async () => {
    mocks.getTemplate.mockResolvedValue({ ok: false, error: "notFound" });
    await render();
    expect(screen.getAllByRole("alert")[0].textContent).toContain("Templat dokumen");
  });

  it("explains a pinned version that no longer exists instead of a bare 404", async () => {
    mocks.loadExportSnapshot.mockResolvedValue({ ok: false, error: "missingVersion" });
    await render();
    expect(screen.getByRole("alert").textContent).toContain("versi soal");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("reads the logo only when the template has one, and survives a failed read", async () => {
    await render();
    expect(mocks.readLogo).not.toHaveBeenCalled();
    cleanup();
    mocks.getTemplate.mockResolvedValue({
      ok: true,
      data: { ...templateFixture, hasLogo: true },
    });
    mocks.readLogo.mockResolvedValue({
      ok: true,
      data: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" },
    });
    await render();
    expect(frame().getAttribute("srcdoc")).toContain("data:image/png;base64,AQID");
    cleanup();
    const logged = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mocks.readLogo.mockRejectedValue(new Error("no store"));
    await render();
    expect(frame().getAttribute("srcdoc")).not.toContain("data:image/png");
    expect(logged).toHaveBeenCalledWith(
      { module: "export", err: { name: "Error", code: null } },
      "export: could not read the template logo for the preview",
    );
    logged.mockRestore();
  });

  it("says the PDF may break lines and pages differently from the preview (decision 13)", async () => {
    await render();
    expect(
      screen.getByText(
        "Pratinjau ini menunjukkan isi dokumen; pemisahan baris dan halaman di PDF dapat sedikit berbeda.",
      ),
    ).toBeTruthy();
    cleanup();
    setTestLocale("en");
    await render();
    expect(
      screen.getByText(
        "This preview shows the content of the document; line and page breaks in the PDF may differ slightly.",
      ),
    ).toBeTruthy();
  });

  it("links back to the editor", async () => {
    await render();
    expect(
      screen.getByRole("link", { name: /Kembali ke penyusun/ }).getAttribute("href"),
    ).toBe(`/assessment-builder/${ID}`);
  });
});
