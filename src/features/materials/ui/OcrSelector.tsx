"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, type SubmitEvent } from "react";
import {
  prepareOcrUploadsAction,
  queueOcrAction,
  type PrepareOcrUploadsState,
  type QueueOcrState,
} from "../actions/ocr";
import {
  MAX_PAGE_IMAGE_BYTES,
  USER_DAILY_OCR_PAGES,
  USER_DAILY_VISION_READS,
} from "../schema/ocr";
import { LiveNotice, type Notice } from "./LiveNotice";
import { materialFileUrl } from "./PageViewer";
import { putFile } from "./put-file";
import { card, primaryButton } from "./styles";

const SELECTABLE = new Set(["available", "failed"]);

/** Whether the browser must send pictures of the pages (PDF pages, photos too large to send). */
function needsPictures(kind: string, sizeBytes: number): boolean {
  return kind === "pdf" || (kind === "image" && sizeBytes > MAX_PAGE_IMAGE_BYTES);
}

/**
 * Chooses pages for OCR (decision 5): only pages whose OCR is available or failed, never more than
 * are left today ("x of 20 pages left today"). For a PDF the browser first renders each chosen
 * page as a PNG with pdfjs-dist and uploads it to its signed URL (Ruling R3); then the pages are
 * queued and counted.
 */
export function OcrSelector({
  materialId,
  kind,
  sizeBytes,
  pages,
  left,
  visionLeft,
}: {
  materialId: string;
  kind: string;
  sizeBytes: number;
  pages: { pageNo: number; ocrStatus: string; textSource: string | null }[];
  left: number;
  /** Vision reads left today, OCR pages and solver photos together (R28). */
  visionLeft: number;
}) {
  const t = useTranslations("materials.ocr.selector");
  const router = useRouter();
  const id = useId();
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [remaining, setRemaining] = useState(left);
  // A refresh brings a new count from the server (another tab, a refund): take it.
  const [seenLeft, setSeenLeft] = useState(left);
  if (seenLeft !== left) {
    setSeenLeft(left);
    setRemaining(left);
  }
  // Pages the teacher corrected by hand: OCR would replace that text, so it asks once more.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const selectable = pages.filter((page) => SELECTABLE.has(page.ocrStatus));
  const corrected = new Set(
    pages.filter((page) => page.textSource === "manual").map((page) => page.pageNo),
  );

  function toggle(pageNo: number, on: boolean) {
    setChosen((current) =>
      on
        ? [...new Set([...current, pageNo])].sort((a, b) => a - b)
        : current.filter((n) => n !== pageNo),
    );
  }

  /** Renders and uploads the chosen pages' pictures; false (with a notice) when that fails. */
  async function sendPictures(pageNos: number[]): Promise<boolean> {
    const render = await import("./pdf-render");
    const blobs: { pageNo: number; blob: Blob }[] = [];
    const blank: number[] = [];
    const held = kind === "pdf" ? render.acquirePdf(materialFileUrl(materialId)) : null;
    try {
      const pdf = held ? await held.pdf : null;
      for (const pageNo of pageNos) {
        setNotice({
          kind: "status",
          text: t("preparing", { done: blobs.length, total: pageNos.length }),
        });
        const picture = pdf
          ? await render.renderPdfPagePng(pdf, pageNo)
          : await render.renderImagePng(materialFileUrl(materialId));
        if (picture.blank) blank.push(pageNo);
        blobs.push({ pageNo, blob: picture.png });
      }
    } catch {
      setNotice({ kind: "alert", text: t("errors.render") });
      return false;
    } finally {
      held?.release();
    }
    // Nothing to read on them (or a scan this browser could not draw): never spend the cap.
    if (blank.length > 0) {
      setNotice({
        kind: "alert",
        text: t("errors.blank", { pages: blank.join(", "), count: blank.length }),
      });
      return false;
    }
    let prepared: PrepareOcrUploadsState;
    try {
      prepared = await prepareOcrUploadsAction({
        materialId,
        pages: blobs.map(({ pageNo, blob }) => ({ pageNo, size: blob.size })),
      });
    } catch {
      prepared = { ok: false, error: "generic" };
    }
    if (!prepared.ok) {
      setNotice({ kind: "alert", text: t(`errors.${prepared.error}`) });
      return false;
    }
    for (const upload of prepared.uploads) {
      const blob = blobs.find((entry) => entry.pageNo === upload.pageNo)?.blob;
      const file =
        blob && new File([blob], `${String(upload.pageNo)}.png`, { type: "image/png" });
      if (!file || !(await putFile(upload.url, file, "image/png", () => undefined))) {
        setNotice({ kind: "alert", text: t("errors.upload") });
        return false;
      }
    }
    return true;
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen.length === 0) {
      setNotice({ kind: "alert", text: t("choose") });
      return;
    }
    if (chosen.length > remaining) {
      setNotice({ kind: "alert", text: t("tooMany", { left: remaining }) });
      return;
    }
    const overwrites = chosen.filter((pageNo) => corrected.has(pageNo));
    const selection = chosen.join(",");
    if (overwrites.length > 0 && confirmed !== selection) {
      setConfirmed(selection);
      setNotice({
        kind: "alert",
        text: t("overwrite", { pages: overwrites.join(", "), count: overwrites.length }),
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (needsPictures(kind, sizeBytes) && !(await sendPictures(chosen))) return;
      let result: QueueOcrState;
      try {
        result = await queueOcrAction({ materialId, pageNos: chosen });
      } catch {
        result = { ok: false, error: "generic" };
      }
      if (!result.ok) {
        setNotice({ kind: "alert", text: t(`errors.${result.error}`) });
        return;
      }
      setRemaining(result.left);
      setNotice({ kind: "status", text: t("queued", { count: chosen.length }) });
      setChosen([]);
      setConfirmed(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className={card}>
      <h2 id={`${id}-heading`} className="font-heading text-lg font-semibold">
        {t("heading")}
      </h2>
      <p className="text-sm">{t("intro")}</p>
      <p className="text-sm font-semibold">
        {t("left", { left: remaining, cap: USER_DAILY_OCR_PAGES })}
      </p>
      <p className="text-sm">
        {t("visionLeft", { left: visionLeft, cap: USER_DAILY_VISION_READS })}
      </p>
      {selectable.length === 0 ? (
        <p className="text-sm">{t("none")}</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <fieldset className="flex min-w-0 flex-col gap-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">{t("legend")}</legend>
            <div className="flex flex-wrap gap-2">
              {selectable.map((page) => (
                <label
                  key={page.pageNo}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={chosen.includes(page.pageNo)}
                    onChange={(event) => {
                      toggle(page.pageNo, event.currentTarget.checked);
                    }}
                  />
                  {t("page", { page: page.pageNo })}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={busy || remaining === 0}
            className={`${primaryButton} self-start`}
          >
            {t("submit")}
          </button>
        </form>
      )}
      <LiveNotice notice={notice} />
    </section>
  );
}
