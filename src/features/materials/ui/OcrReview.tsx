"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type SubmitEvent } from "react";
import { StatusPill } from "@/components/ui/status-pill";
import { savePageTextAction, type SavePageTextState } from "../actions/ocr";
import { MAX_MANUAL_PAGE_CHARS } from "../schema/ocr";
import { LiveNotice, type Notice } from "./LiveNotice";
import { PageViewer } from "./PageViewer";
import { card, control, primaryButton, secondaryButton } from "./styles";

const MARK = "[[?]]";
const FLAGS = ["uncertain_math", "low_text", "garbled", "truncated"] as const;
const SOURCES = ["pdf_text", "docx", "ocr", "manual"] as const;
const STATUSES = ["none", "available", "queued", "done", "failed"] as const;

/** `value` when it is one of `known`, else `fallback` (stored strings are not trusted as keys). */
function oneOf<T extends string>(
  known: readonly T[],
  value: string | null,
  fallback: T,
): T {
  return known.find((entry) => entry === value) ?? fallback;
}

export interface ReviewPageView {
  pageNo: number;
  textMd: string;
  confidence: string;
  flags: string[];
  ocrStatus: string;
  textSource: string | null;
}

/** The parts of a text between a pair of `[[?]]` marks: where each starts and ends (marks included). */
export function markedParts(
  text: string,
): { start: number; end: number; text: string }[] {
  const parts: { start: number; end: number; text: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(MARK, from);
    if (start < 0) break;
    const close = text.indexOf(MARK, start + MARK.length);
    if (close < 0) break;
    const end = close + MARK.length;
    parts.push({ start, end, text: text.slice(start + MARK.length, close) });
    from = end;
  }
  return parts;
}

const pageHref = (materialId: string, pageNo: number) =>
  `/materials/${materialId}?page=${String(pageNo)}#halaman`;

/**
 * The review of one page (decision 7): its picture beside its text, the reasons it needs checking
 * ("perlu diperiksa", never a percentage), the parts the OCR marked `[[?]]` highlighted with a jump
 * from one to the next, and the correction saved as the teacher's own text. Pages are reached by
 * links (previous, next, next one to check) or by number.
 */
export function OcrReview({
  materialId,
  kind,
  total,
  page,
  nextFlagged,
}: {
  materialId: string;
  kind: string;
  total: number;
  page: ReviewPageView;
  nextFlagged: number | null;
}) {
  const t = useTranslations("materials.ocr");
  const router = useRouter();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(page.textMd);
  // New stored text (after a save or an OCR run, through a refresh) replaces the editor's; the
  // component itself stays mounted, so its saved notice is still announced.
  const [stored, setStored] = useState(page.textMd);
  if (stored !== page.textMd) {
    setStored(page.textMd);
    setText(page.textMd);
  }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const parts = markedParts(text);
  const queued = page.ocrStatus === "queued";
  const needsCheck = page.confidence !== "high";
  const source = oneOf([...SOURCES, "none"], page.textSource, "none");
  const status = oneOf(STATUSES, page.ocrStatus, "none");
  const flags = FLAGS.filter((flag) => page.flags.includes(flag));

  function select(part: { start: number; end: number }) {
    const element = area.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(part.start, part.end);
  }

  function jump() {
    const after = area.current?.selectionEnd ?? 0;
    const next = parts.find((part) => part.start >= after) ?? parts.at(0);
    if (next) select(next);
  }

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    let result: SavePageTextState;
    try {
      result = await savePageTextAction({
        materialId,
        pageNo: page.pageNo,
        textMd: text,
      });
    } catch {
      result = { ok: false, error: "generic" };
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setNotice({
        kind: "alert",
        text: t(`editor.errors.${result.error}`, { max: MAX_MANUAL_PAGE_CHARS }),
      });
      return;
    }
    setNotice({ kind: "status", text: t("editor.saved") });
    router.refresh();
  }

  return (
    <section id="halaman" aria-labelledby={`${id}-heading`} className={card}>
      <h2 id={`${id}-heading`} className="font-heading text-lg font-semibold">
        {t("heading")}
      </h2>
      <p className="text-sm">{t("intro")}</p>

      <nav
        aria-label={t("pageOf", { page: page.pageNo, total })}
        className="flex flex-wrap items-center gap-2"
      >
        {page.pageNo > 1 && (
          <Link href={pageHref(materialId, page.pageNo - 1)} className={secondaryButton}>
            {t("previous")}
          </Link>
        )}
        <span className="text-sm font-semibold">
          {t("pageOf", { page: page.pageNo, total })}
        </span>
        {page.pageNo < total && (
          <Link href={pageHref(materialId, page.pageNo + 1)} className={secondaryButton}>
            {t("next")}
          </Link>
        )}
        {nextFlagged !== null && (
          <Link href={pageHref(materialId, nextFlagged)} className={secondaryButton}>
            {t("nextFlagged")}
          </Link>
        )}
        <form
          action={`/materials/${materialId}#halaman`}
          method="get"
          className="flex items-end gap-2"
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("choosePage")}
            <input
              type="number"
              name="page"
              min={1}
              max={total}
              defaultValue={page.pageNo}
              className={`${control} w-24`}
            />
          </label>
          <button type="submit" className={secondaryButton}>
            {t("open")}
          </button>
        </form>
      </nav>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <PageViewer materialId={materialId} kind={kind} pageNo={page.pageNo} />
        <form
          onSubmit={(event) => void save(event)}
          className="flex min-w-0 flex-col gap-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={needsCheck ? "warning" : "success"}>
              {needsCheck ? t("needsCheck") : t("clear")}
            </StatusPill>
            <span className="text-sm text-muted-foreground">{t(`source.${source}`)}</span>
            <span className="text-sm text-muted-foreground">{t(`status.${status}`)}</span>
          </div>
          {flags.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {flags.map((flag) => (
                <li key={flag}>{t(`flags.${flag}`)}</li>
              ))}
            </ul>
          )}
          <label htmlFor={`${id}-text`} className="text-sm font-medium">
            {t("editor.label", { page: page.pageNo })}
          </label>
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            {t("editor.hint")}
          </p>
          <textarea
            id={`${id}-text`}
            ref={area}
            value={text}
            readOnly={queued}
            aria-describedby={`${id}-hint ${id}-marks`}
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
            rows={16}
            maxLength={MAX_MANUAL_PAGE_CHARS}
            className={`${control} min-h-64 py-2 font-mono`}
          />
          <p id={`${id}-marks`} className="text-sm">
            {t("editor.marks", { count: parts.length })}
          </p>
          {parts.length > 0 && (
            <>
              <ol className="flex flex-wrap gap-2">
                {parts.map((part, index) => (
                  <li key={`${String(part.start)}-${String(index)}`}>
                    <button
                      type="button"
                      onClick={() => {
                        select(part);
                      }}
                      aria-label={`${t("editor.partLabel")} ${part.text.trim() === "" ? MARK : part.text}`}
                      className="min-h-11 rounded-lg border px-2 text-left text-sm"
                    >
                      <mark className="rounded bg-warning-soft px-1 text-warning-foreground">
                        {part.text.trim() === "" ? MARK : part.text}
                      </mark>
                    </button>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={jump}
                className={`${secondaryButton} self-start`}
              >
                {t("editor.jump")}
              </button>
            </>
          )}
          {queued ? (
            <p className="text-sm">{t("editor.queued")}</p>
          ) : (
            <button
              type="submit"
              disabled={busy}
              className={`${primaryButton} self-start`}
            >
              {busy ? t("editor.saving") : t("editor.save")}
            </button>
          )}
          <LiveNotice notice={notice} />
        </form>
      </div>
    </section>
  );
}
