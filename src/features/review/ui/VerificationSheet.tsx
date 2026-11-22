import { useTranslations } from "next-intl";
import { Dialog } from "@base-ui/react/dialog";
import { useId } from "react";
import type { ReviewQuestion } from "@/features/review/service/review";
import { checkTypeKey, type DisplayStatus } from "./status-meta";
import { VerificationBadge } from "./VerificationBadge";

export function VerificationSheet({
  questionNumber,
  verification,
  status,
}: {
  questionNumber: number;
  verification: ReviewQuestion["verification"];
  status: DisplayStatus;
}) {
  const t = useTranslations("review");
  const checksHeadingId = useId();
  return (
    <Dialog.Root>
      <Dialog.Trigger className="inline-flex min-h-11 min-w-11 items-center rounded-lg border border-input bg-card px-3 text-sm font-medium transition-colors duration-150 hover:bg-secondary">
        {t("detailsButton")}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40" />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-xl border bg-card p-6 shadow-lg sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl">
          <div className="flex flex-col gap-4">
            <Dialog.Title className="font-heading text-lg font-bold">
              {t("sheetTitle", { number: String(questionNumber) })}
            </Dialog.Title>
            <VerificationBadge status={status} />
            <Dialog.Description className="text-sm">
              {t(`statusExplanations.${status}`)}
            </Dialog.Description>

            <section aria-labelledby={checksHeadingId} className="flex flex-col gap-2">
              <h3 id={checksHeadingId} className="text-sm font-semibold">
                {t("checksHeading")}
              </h3>
              {verification.checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noChecks")}</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {verification.checks.map((check, index) => (
                    <li key={index} className="rounded-lg border bg-background p-3">
                      <p className="font-medium">
                        {t(`checkTypes.${checkTypeKey(check.type)}`)} —{" "}
                        {t(`checkResults.${check.status}`)}
                      </p>
                      <p className="min-w-0 break-words text-muted-foreground">
                        {check.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {verification.crossCheck && (
              <p className="text-sm">
                <span className="font-semibold">{t("crossCheckHeading")}: </span>
                {t(`crossCheck.${verification.crossCheck}`)}
              </p>
            )}
            {verification.regenerated && <p className="text-sm">{t("regenerated")}</p>}
            {verification.regenerationFailed && (
              <p className="text-sm">{t("regenerationFailed")}</p>
            )}
            <p className="text-sm font-medium">{t("disclaimer")}</p>
            <Dialog.Close className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-input bg-card px-4 text-sm font-medium transition-colors duration-150 hover:bg-secondary">
              {t("close")}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
