"use client";

import { useTranslations } from "next-intl";
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useId, useRef, useState } from "react";

// Mirrors OVERRIDE_NOTE_MIN / OVERRIDE_NOTE_MAX in features/review/service/decision.ts, which cannot be
// imported here (it pulls in the database schema). The server re-checks the same bounds.
const NOTE_MIN = 10;
const NOTE_MAX = 500;

const baseButtonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";
const buttonClass = `${baseButtonClass} border border-input bg-card text-foreground hover:bg-secondary`;
const submitClass = `${baseButtonClass} bg-primary text-primary-foreground hover:bg-primary-hover`;

// The form is mounted only while the dialog is open, so closing it (or cancelling) resets the fields.
function OverrideForm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const t = useTranslations("review.decision");
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const hintId = useId();
  const trimmedLength = note.trim().length;
  const valid = checked && trimmedLength >= NOTE_MIN && trimmedLength <= NOTE_MAX;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onConfirm(note.trim());
      }}
    >
      <Dialog.Title className="font-heading text-lg font-bold">
        {t("overrideTitle")}
      </Dialog.Title>
      <Dialog.Description className="text-sm">{t("overrideIntro")}</Dialog.Description>

      <label className="flex min-h-11 items-start gap-3 text-sm font-medium">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            setChecked(event.target.checked);
          }}
          className="mt-0.5 size-6 shrink-0 accent-primary"
        />
        <span>{t("overrideConfirm")}</span>
      </label>

      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className="text-sm font-medium">
          {t("overrideNoteLabel")}
        </label>
        {/* Plain text only: the note is never rendered as math or HTML. */}
        <textarea
          id={noteId}
          aria-describedby={hintId}
          value={note}
          maxLength={NOTE_MAX}
          rows={4}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          className="min-h-11 w-full rounded-lg border border-input bg-card p-3 text-sm"
        />
        <p className="flex justify-between gap-2 text-sm text-muted-foreground">
          <span id={hintId}>
            {t("overrideNoteHint", { min: String(NOTE_MIN), max: String(NOTE_MAX) })}
          </span>
          <span aria-hidden="true">
            {note.length}/{NOTE_MAX}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onCancel} className={buttonClass}>
          {t("overrideCancel")}
        </button>
        <button type="submit" disabled={!valid} className={submitClass}>
          {t("overrideSubmit")}
        </button>
      </div>
    </form>
  );
}

export function OverrideDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
}) {
  // Cancel and Escape return focus to the opener (the default). After a confirm the opener is
  // replaced by the decision status, so the caller moves focus to the next control instead.
  const confirmed = useRef(false);
  useEffect(() => {
    if (open) confirmed.current = false;
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40" />
        <Dialog.Popup
          finalFocus={() => !confirmed.current}
          className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-xl border bg-card p-6 shadow-lg sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <OverrideForm
            onCancel={() => {
              onOpenChange(false);
            }}
            onConfirm={(note) => {
              confirmed.current = true;
              onConfirm(note);
              onOpenChange(false);
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
