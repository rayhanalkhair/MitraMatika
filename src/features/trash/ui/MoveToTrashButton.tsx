import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { TrashActionResult } from "../actions/action-support";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTrashErrorText, type TrashEntity } from "./error-key";

export interface MoveToTrashCopy {
  button: string;
  buttonLabel: string;
  title: string;
  description: string;
  cancel: string;
  confirm: string;
  working: string;
}

// No "use client": imported only by client modules (the Trash*Button wrappers), so it is client
// code by import and its function prop need not be serialisable.
/**
 * Moves a row to the trash after a confirmation. With `afterTrash` the teacher is taken there (the
 * page they were on shows the row that left); otherwise the page re-reads and focus goes to the
 * page heading, since the button left with its row. `copy.buttonLabel` names the row, so a list of
 * buttons stays clear.
 */
export function MoveToTrashButton({
  entity,
  onTrash,
  copy,
  afterTrash,
  compact = false,
}: {
  entity: TrashEntity;
  onTrash: () => Promise<TrashActionResult>;
  copy: MoveToTrashCopy;
  afterTrash?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const errorText = useTrashErrorText();
  const openerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  useEffect(() => {
    if (!focusHeading || open) return;
    const heading = document.querySelector<HTMLElement>("h1");
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
  }, [focusHeading, open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    const result = await onTrash();
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result, entity));
      return;
    }
    setOpen(false);
    if (afterTrash) router.push(afterTrash);
    else {
      setFocusHeading(true);
      router.refresh();
    }
  }

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-label={copy.buttonLabel}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={
          compact
            ? "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            : "inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-sm font-semibold text-destructive hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        }
      >
        <Trash2 aria-hidden="true" className="size-4" />
        {compact ? null : copy.button}
      </button>
      {open && (
        <ConfirmDialog
          title={copy.title}
          confirmLabel={copy.confirm}
          workingLabel={copy.working}
          cancelLabel={copy.cancel}
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onClosed={() => {
            setOpen(false);
            openerRef.current?.focus();
          }}
        >
          <p>{copy.description}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
