import { useFormatter, useTranslations } from "next-intl";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Shuffle } from "lucide-react";
import {
  setPointsAction,
  setScoringModeAction,
  setShuffleAction,
} from "../actions/scoring";
import { pointsFormSchema, type PointsFormValues } from "../schema/assessment";
import {
  parsePoints,
  SCORING_MODES,
  scorePoints,
  totalPoints,
  type ScoringMode,
} from "../service/scoring";
import { control, primaryButton, secondaryButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

// No "use client": rendered only by AssessmentEditor (a client module), so its function props
// need not be serialisable.

interface ScoredItem {
  itemId: string;
  /** The outline number the editor shows. */
  number: number;
  /** The teacher's stored points. */
  points: number;
}

/**
 * Scoring (decision 5) and the shuffle (decision 4): the mode as a radio group, the points per
 * question for the manual modes with the live total (the same rules the server approves with),
 * and the shuffle switch. Everything is read-only while the assessment is locked.
 */
export function ScoringPanel({
  assessmentId,
  mode,
  shuffled,
  items,
  locked,
  busy,
  run,
}: {
  assessmentId: string;
  mode: ScoringMode;
  shuffled: boolean;
  items: ScoredItem[];
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments.scoring");
  const off = locked || busy;
  const headingId = useId();
  const legendId = useId();
  const shuffleId = useId();
  const shuffleHintId = useId();
  const reshuffleId = useId();
  const radioId = (value: ScoringMode) => `${headingId}-${value}-radio`;

  // Every control is disabled while an action runs: after the refresh the keyboard goes back to
  // the control that was used (use-editor-run).
  function changeMode(next: ScoringMode) {
    run(() => setScoringModeAction({ assessmentId, mode: next }), {
      done: t("modeSaved"),
      focus: [radioId(next)],
    });
  }

  function shuffle(next: "on" | "off" | "reshuffle") {
    const done = { on: t("shuffleOn"), off: t("shuffleOff"), reshuffle: t("reshuffled") };
    run(() => setShuffleAction({ assessmentId, mode: next }), {
      done: done[next],
      focus: next === "reshuffle" ? [reshuffleId, shuffleId] : [shuffleId],
    });
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 shadow-card"
    >
      <h2 id={headingId} className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>

      <div role="radiogroup" aria-labelledby={legendId} className="flex flex-col gap-2">
        <span id={legendId} className="font-heading text-sm font-semibold">
          {t("modeLegend")}
        </span>
        {SCORING_MODES.map((value) => (
          // The whole row is the label: a 44 px target that checks the mode.
          <label
            key={value}
            htmlFor={radioId(value)}
            className="grid min-h-11 cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed"
          >
            <input
              id={radioId(value)}
              type="radio"
              name={`${headingId}-mode`}
              value={value}
              checked={mode === value}
              disabled={off}
              onChange={() => {
                changeMode(value);
              }}
              className="mt-1 size-4"
            />
            <span className="text-sm font-semibold">{t(`mode.${value}`)}</span>
            <span className="col-start-2 text-sm text-muted-foreground">
              {t(`modeHint.${value}`)}
            </span>
          </label>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : mode === "equal" ? (
        <p className="text-sm font-semibold">
          {t("total", {
            total: totalPoints(
              scorePoints(
                "equal",
                items.map((i) => i.points),
              ) ?? [],
            ),
          })}
        </p>
      ) : (
        <PointsForm
          // New stored points (after a save and refresh) start the form again from the server.
          key={items.map((item) => `${item.itemId}:${String(item.points)}`).join()}
          assessmentId={assessmentId}
          mode={mode}
          items={items}
          off={off}
          run={run}
        />
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor={shuffleId} className="flex min-h-11 items-center gap-3">
            <input
              id={shuffleId}
              type="checkbox"
              checked={shuffled}
              disabled={off}
              aria-describedby={shuffleHintId}
              onChange={(event) => {
                shuffle(event.target.checked ? "on" : "off");
              }}
              className="size-4"
            />
            <span className="text-sm font-semibold">{t("shuffle")}</span>
          </label>
          {shuffled && (
            <button
              id={reshuffleId}
              type="button"
              disabled={off}
              onClick={() => {
                shuffle("reshuffle");
              }}
              className={secondaryButton}
            >
              <Shuffle aria-hidden="true" className="size-4" />
              {t("reshuffle")}
            </button>
          )}
        </div>
        <p id={shuffleHintId} className="text-sm text-muted-foreground">
          {t("shuffleHint")}
        </p>
      </div>
    </section>
  );
}

function PointsForm({
  assessmentId,
  mode,
  items,
  off,
  run,
}: {
  assessmentId: string;
  mode: "manual" | "normalised";
  items: ScoredItem[];
  off: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments.scoring");
  const format = useFormatter();
  const legendId = useId();
  const hintId = useId();
  const totalId = useId();
  const saveId = useId();
  // Stored points in the locale's notation ("2,5" in Indonesian); parsePoints reads both.
  const form = useForm<PointsFormValues, unknown, Record<string, number>>({
    resolver: zodResolver(pointsFormSchema),
    defaultValues: {
      points: Object.fromEntries(
        items.map((item) => [
          item.itemId,
          format.number(item.points, { maximumFractionDigits: 2, useGrouping: false }),
        ]),
      ),
    },
  });
  // The rows as typed: the live total and the rows that are not valid points follow every
  // keystroke, with the same schema the button and the server use.
  const typed = useWatch({ control: form.control, name: "points" });
  const checked = pointsFormSchema.safeParse({ points: typed });
  const invalidIds = new Set(
    checked.success ? [] : checked.error.issues.map((issue) => issue.path[1]),
  );
  const valid = checked.success;
  const numbers = items.map((item) => parsePoints(typed[item.itemId] ?? "") ?? 0);
  const scaled = mode === "normalised" ? scorePoints("normalised", numbers) : null;
  const total = totalPoints(mode === "normalised" ? (scaled ?? []) : numbers);

  const save = form.handleSubmit(() => {
    // The strings as typed: the server parses them with the same schema.
    const points = form.getValues("points");
    run(() => setPointsAction({ assessmentId, points }), {
      done: t("saved"),
      focus: [saveId],
    });
  });

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
      className="flex flex-col gap-3"
    >
      <fieldset aria-describedby={hintId} className="flex flex-col gap-2">
        <legend id={legendId} className="font-heading text-sm font-semibold">
          {t("pointsLegend")}
        </legend>
        <p id={hintId} className="text-sm text-muted-foreground">
          {t("pointsHint")}
        </p>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map((item, index) => {
            const inputId = `${legendId}-${item.itemId}`;
            const invalid = invalidIds.has(item.itemId);
            return (
              <li key={item.itemId} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={inputId} className="text-sm font-semibold">
                  {t("pointsLabel", { n: item.number })}
                </label>
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  {...form.register(`points.${item.itemId}`)}
                  disabled={off}
                  aria-invalid={invalid || undefined}
                  aria-describedby={hintId}
                  className={control}
                />
                {scaled && (
                  <span className="text-sm text-muted-foreground">
                    {t("scaled", { points: scaled[index] })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          {/* Not a live region: it would speak on every keystroke. Save is described by it. */}
          <p id={totalId} className="text-sm font-semibold">
            {t("total", { total })}
          </p>
          {mode === "normalised" && (
            <p className="text-sm text-muted-foreground">{t("needs100")}</p>
          )}
        </div>
        <button
          id={saveId}
          type="submit"
          disabled={off || !valid}
          aria-describedby={totalId}
          className={primaryButton}
        >
          {t("save")}
        </button>
      </div>
    </form>
  );
}
