"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { noticeClass } from "./styles";

/** The owner-checked route that serves (or redirects to) a material's stored file. */
export const materialFileUrl = (materialId: string) =>
  `/api/materials/${materialId}/file`;
/** CSS pixels of the longest side of a PDF page in the viewer (sharp on a 2x screen). */
const VIEW_SIDE = 1_400;

type Load = "loading" | "ready" | "failed";

/**
 * The picture of one page (decision 7): an image material is shown from its stored file; a PDF
 * page is drawn in the browser with pdfjs-dist (the server never renders PDFs, Ruling R3); a Word
 * document has no page picture. The document is fetched once per material and kept while the
 * teacher moves between pages and saves (pdf-render.ts acquirePdf).
 */
export function PageViewer({
  materialId,
  kind,
  pageNo,
}: {
  materialId: string;
  kind: string;
  pageNo: number;
}) {
  const t = useTranslations("materials.ocr.viewer");
  const label = t("label", { page: pageNo });
  if (kind === "image") {
    return (
      // A private, owner-checked file: next/image would proxy it through the optimiser.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={materialFileUrl(materialId)}
        alt={label}
        className="h-auto w-full rounded-lg border bg-muted object-contain"
      />
    );
  }
  if (kind !== "pdf") return <p className="text-sm">{t("noImage")}</p>;
  return <PdfPage materialId={materialId} pageNo={pageNo} label={label} />;
}

function PdfPage({
  materialId,
  pageNo,
  label,
}: {
  materialId: string;
  pageNo: number;
  label: string;
}) {
  const t = useTranslations("materials.ocr.viewer");
  const canvas = useRef<HTMLCanvasElement>(null);
  // The outcome of the last drawing, for the page it drew: another page shows "loading" until
  // its own drawing ends (no state is set synchronously in the effect).
  const key = `${materialId}:${String(pageNo)}`;
  const [drawn, setDrawn] = useState<{ key: string; ok: boolean } | null>(null);
  const load: Load = drawn?.key !== key ? "loading" : drawn.ok ? "ready" : "failed";

  useEffect(() => {
    // The material's document is shared and kept across page turns (pdf-render.ts acquirePdf);
    // leaving the page cancels the drawing and releases it.
    const controller = new AbortController();
    const aborted = () => controller.signal.aborted;
    let release: (() => void) | null = null;
    const finish = (ok: boolean) => {
      if (!aborted()) {
        setDrawn({ key: `${materialId}:${String(pageNo)}`, ok });
      }
    };
    void (async () => {
      try {
        const render = await import("./pdf-render");
        if (aborted()) return;
        const held = render.acquirePdf(materialFileUrl(materialId));
        release = held.release;
        const pdf = await held.pdf;
        const target = canvas.current;
        if (aborted() || !target) return;
        await render.drawPdfPage(pdf, pageNo, target, VIEW_SIDE, controller.signal);
        finish(true);
      } catch {
        finish(false);
      }
    })();
    return () => {
      controller.abort();
      release?.();
    };
  }, [materialId, pageNo]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        aria-busy={load === "loading"}
        className={
          load === "ready" ? "h-auto w-full rounded-lg border bg-white" : "hidden"
        }
      />
      {load === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      )}
      {load === "failed" && (
        <p role="alert" className={noticeClass("alert")}>
          {t("failed")}
        </p>
      )}
    </div>
  );
}
