import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LockOpen } from "lucide-react";
import { approveAction, reopenAction } from "../actions/approval";
import type { ApprovalProblem, ApprovalState } from "../service/approval";
import { itemAnchorId } from "./ItemRow";
import { primaryButton, secondaryButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

// No "use client": rendered only by AssessmentEditor (a client module).

interface Entry {
  key: string;
  text: string;
  itemId?: string;
}

/**
 * The approval gate (decision 6): what still blocks approval, each item problem linked to the
 * question in the outline; the approve button (disabled, described by the list, while anything
 * blocks it); and, once approved, the date and a reopen that asks for confirmation first.
 */
export function ApprovalPanel({
  assessmentId,
  state,
  busy,
  run,
}: {
  assessmentId: string;
  state: ApprovalState;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments.approval");
  const format = useFormatter();
  const headingId = useId();
  const listId = useId();
  const confirmId = useId();
  const approveId = useId();
  const reopenId = useId();
  const staleId = useId();
  const [confirming, setConfirming] = useState(false);
  // The problems a refused approve returned, shown until the page brings a new snapshot.
  const [returned, setReturned] = useState<{
    hash: string;
    problems: ApprovalProblem[];
  } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      reopenRef.current?.focus();
    }
  }, [confirming]);

  const problems = returned?.hash === state.hash ? returned.problems : state.problems;
  const entries = problems.flatMap((problem) => describe(problem, t));
  const templateTrashed = state.problems.some(
    (problem) => problem.code === "trashed" && "template" in problem,
  );

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 shadow-card"
    >
      <h2 id={headingId} className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>

      {state.approved ? (
        <>
          <p className="flex items-start gap-2 text-sm">
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-success"
            />
            {state.approvedAt &&
              t("approvedOn", {
                date: format.dateTime(new Date(state.approvedAt), {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }),
              })}
          </p>
          {state.stale && (
            <p
              id={staleId}
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {t("stale")}
                {/* The one reason the page can name: the template went to the trash. */}
                {templateTrashed && <> {t("problem.templateTrashed")}</>}
              </span>
            </p>
          )}
          {confirming ? (
            <div
              role="group"
              aria-labelledby={confirmId}
              aria-describedby={`${confirmId}-body`}
              className="flex flex-col gap-3 rounded-lg border p-4"
            >
              <p id={confirmId} className="font-heading font-semibold">
                {t("reopenTitle")}
              </p>
              <p id={`${confirmId}-body`} className="text-sm text-muted-foreground">
                {t("reopenBody")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    run(() => reopenAction({ assessmentId }), {
                      done: t("reopened"),
                      // The approve button takes the place of the reopen controls.
                      focus: [approveId],
                    });
                  }}
                  className={primaryButton}
                >
                  {t("reopenConfirm")}
                </button>
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={() => {
                    returnFocus.current = true;
                    setConfirming(false);
                  }}
                  className={secondaryButton}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                ref={reopenRef}
                id={reopenId}
                type="button"
                aria-describedby={state.stale ? staleId : undefined}
                disabled={busy}
                onClick={() => {
                  setConfirming(true);
                }}
                className={secondaryButton}
              >
                <LockOpen aria-hidden="true" className="size-4" />
                {t("reopen")}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {entries.length === 0 ? (
            <p id={listId} className="text-sm">
              {t("ready")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p id={listId} className="text-sm font-semibold">
                {t("notReady", { count: entries.length })}
              </p>
              <ul
                aria-labelledby={listId}
                className="flex list-disc flex-col gap-1 pl-5 text-sm"
              >
                {entries.map((entry) => (
                  <li key={entry.key}>
                    {entry.itemId ? (
                      <a
                        href={`#${itemAnchorId(entry.itemId)}`}
                        onClick={(event) => {
                          // Move the keyboard to the question as well as the view.
                          const target = document.getElementById(
                            itemAnchorId(entry.itemId ?? ""),
                          );
                          if (target) {
                            event.preventDefault();
                            target.scrollIntoView({ block: "center" });
                            target.focus();
                          }
                        }}
                        className="font-semibold text-primary underline underline-offset-4"
                      >
                        {entry.text}
                      </a>
                    ) : (
                      entry.text
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <button
              id={approveId}
              type="button"
              disabled={busy || entries.length > 0}
              aria-describedby={listId}
              onClick={() => {
                const seen = state.hash;
                run(() => approveAction({ assessmentId, expectedHash: seen }), {
                  done: t("approved"),
                  // The reopen button takes the place of approve.
                  focus: [reopenId],
                  // The server's view differs from the page's: show it.
                  refreshOnRefusal: true,
                  refused: (failure) => {
                    if (failure.reason === "notReady") {
                      setReturned({ hash: seen, problems: failure.problems ?? [] });
                      return t("refusedNotReady");
                    }
                    return failure.reason === "conflict" ? t("refusedConflict") : null;
                  },
                });
              }}
              className={primaryButton}
            >
              <CheckCircle2 aria-hidden="true" className="size-4" />
              {t("approve")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type Translate = ReturnType<typeof useTranslations<"assessments.approval">>;

/** One problem as one or more list entries (a scoring problem names each unscored question). */
function describe(problem: ApprovalProblem, t: Translate): Entry[] {
  switch (problem.code) {
    case "empty":
      return [{ key: "empty", text: t("problem.empty") }];
    case "badTotal": {
      const total =
        problem.mode === "manual"
          ? problem.total > 0
            ? []
            : [{ key: "total", text: t("problem.badTotalManual") }]
          : problem.total === 100
            ? []
            : [{ key: "total", text: t("problem.badTotal", { total: problem.total }) }];
      return [
        ...total,
        ...problem.unscored.map((item) => ({
          key: `unscored-${item.itemId}`,
          text: t("problem.unscored", { n: item.number }),
          itemId: item.itemId,
        })),
      ];
    }
    default:
      if ("template" in problem) {
        return [{ key: "template", text: t("problem.templateTrashed") }];
      }
      return [
        {
          key: `${problem.code}-${problem.itemId}`,
          text: t(`problem.${problem.code}`, { n: problem.number }),
          itemId: problem.itemId,
        },
      ];
  }
}
