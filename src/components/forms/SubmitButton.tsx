import { Loader } from "lucide-react";
import { submitClass } from "./field-styles";

/** The submit button: disabled and aria-busy while the action runs, with the pending label. */
export function SubmitButton({
  pending,
  label,
  pendingLabel,
  className = submitClass,
  spinner = false,
  disabled = false,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  className?: string;
  spinner?: boolean;
  /** Disabled for another reason (a locked form); not busy, so the label stays. */
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={className}
    >
      {spinner && pending && (
        <Loader aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      )}
      {pending ? pendingLabel : label}
    </button>
  );
}
