// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

// The real pdf-render.ts over a stand-in pdfjs-dist: what it asks pdf.js for, and how long it
// keeps a document, seen through the real page components.
const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(),
  cancel: vi.fn(),
  render: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  version: "9.9.9",
  GlobalWorkerOptions: {},
  getDocument: pdfjs.getDocument,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../actions/ocr", () => ({
  prepareOcrUploadsAction: vi.fn(),
  queueOcrAction: vi.fn(),
  savePageTextAction: vi.fn(),
}));

import type { ReviewPageView } from "./OcrReview";
import { OcrReview } from "./OcrReview";
import { RELEASE_GRACE_MS } from "./pdf-render";

const fetchMock = vi.fn();
const fakePdf = {
  getPage: () =>
    Promise.resolve({
      getViewport: () => ({ width: 100, height: 140 }),
      render: (...args: unknown[]) => {
        pdfjs.render(...args);
        return { promise: Promise.resolve(), cancel: pdfjs.cancel };
      },
    }),
};

beforeEach(() => {
  vi.clearAllMocks();
  pdfjs.getDocument.mockImplementation(() => ({
    promise: Promise.resolve(fakePdf),
    destroy: () => {
      pdfjs.destroy();
      return Promise.resolve();
    },
  }));
  fetchMock.mockImplementation(() => Promise.resolve(new Response(new Uint8Array([37]))));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "Worker",
    class {
      terminate() {
        return undefined;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const page = (pageNo: number, textMd = "Teks"): ReviewPageView => ({
  pageNo,
  textMd,
  confidence: "high",
  flags: [],
  ocrStatus: "done",
  textSource: "ocr",
});

/** As /materials/[id] renders it: one review per page, keyed by the page number. */
function Review({ id, view }: { id: string; view: ReviewPageView }) {
  return (
    <OcrReview
      key={String(view.pageNo)}
      materialId={id}
      kind="pdf"
      total={5}
      page={view}
      nextFlagged={null}
    />
  );
}

describe("pdf-render", () => {
  it("points pdf.js at its decoders, colour profile and fonts on this origin", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    renderWithIntl(<Review id={id} view={page(1)} />);
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalledTimes(1);
    });
    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        wasmUrl: "/pdfjs/9.9.9/wasm/",
        iccUrl: "/pdfjs/9.9.9/iccs/",
        standardFontDataUrl: "/pdfjs/9.9.9/standard_fonts/",
        enableXfa: false,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(`/api/materials/${id}/file`, {
      credentials: "same-origin",
    });
  });

  it("keeps one document across page turns and saves, and destroys it after leaving", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const view = renderWithIntl(<Review id={id} view={page(1)} />);
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalledTimes(1);
    });
    // Next page (a new review mounts), then the refresh after a save (new text, same page).
    view.rerender(<Review id={id} view={page(2)} />);
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalledTimes(2);
    });
    view.rerender(<Review id={id} view={page(2, "Teks baru")} />);
    view.rerender(<Review id={id} view={page(3)} />);
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalledTimes(3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroy).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "Gambar halaman 3" })).toBeTruthy();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
      await Promise.resolve();
    });
    expect(pdfjs.destroy).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pdfjs.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels a drawing still running when the teacher turns the page", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    let finish: () => void = () => undefined;
    pdfjs.getDocument.mockImplementation(() => ({
      destroy: () => Promise.resolve(),
      promise: Promise.resolve({
        ...fakePdf,
        getPage: () =>
          Promise.resolve({
            getViewport: () => ({ width: 100, height: 140 }),
            render: () => {
              pdfjs.render();
              return {
                promise: new Promise<void>((resolve) => {
                  finish = resolve;
                }),
                cancel: pdfjs.cancel,
              };
            },
          }),
      }),
    }));
    const view = renderWithIntl(<Review id={id} view={page(1)} />);
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalledTimes(1);
    });
    view.rerender(<Review id={id} view={page(2)} />);
    expect(pdfjs.cancel).toHaveBeenCalledTimes(1);
    finish();
  });
});
