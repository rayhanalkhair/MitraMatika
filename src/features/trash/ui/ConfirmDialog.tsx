import { useEffect, useId, useRef, type ReactNode } from "react";

export const dangerButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-white transition-colors duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60";
export const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60";

// No "use client": imported only by client modules (TrashList, TrashQuestionButton), so it is
// client code by import and its function props need not be serialisable.
/**
 * A modal confirmation (native <dialog>: focus stays inside, Escape closes unless busy). Mounted
 * only while open; focus starts on Cancel, the safe choice. The opener puts focus back on close.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  workingLabel,
  cancelLabel,
  busy,
  error,
  onConfirm,
  onClosed,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  workingLabel: string;
  cancelLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClosed: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={onClosed}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border bg-card p-5 text-foreground shadow-card backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="font-heading text-lg font-bold">
          {title}
        </h2>
        <div id={bodyId} className="flex flex-col gap-2 text-sm text-muted-foreground">
          {children}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={() => {
              dialogRef.current?.close();
            }}
            className={secondaryButtonClass}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
            className={dangerButtonClass}
          >
            {busy ? workingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
