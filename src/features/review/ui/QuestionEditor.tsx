"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { get, useFieldArray, useForm, useWatch, type FieldPath } from "react-hook-form";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { Field } from "@/components/forms/Field";
import { inputClass } from "@/components/forms/field-styles";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { MathText } from "@/components/math/MathText";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";
import { editQuestionAction, type EditQuestionResult } from "../actions/edit-question";
import {
  EDIT_LIMITS,
  editFormSchema,
  type EditFormValues,
  type EditInput,
} from "../schema/edit-input";

const toForm = (input: EditInput): EditFormValues => ({
  stemMd: input.stemMd,
  options: input.options,
  correctLabel: input.correctLabel,
  answerDisplayMd: input.answerDisplayMd,
  explanationMd: input.explanationMd,
  steps: input.steps.map((textMd) => ({ textMd })),
});

const sameForm = (a: EditFormValues, b: EditFormValues) =>
  JSON.stringify(a) === JSON.stringify(b);

// Nothing outside React changes the draft, so there is nothing to subscribe to.
const noSubscription = () => () => undefined;

const draftKey = (questionId: string) => `question-edit-draft:${questionId}`;

// sessionStorage can be missing or throw (private window, blocked data): the draft is a convenience.
function readRawDraft(questionId: string): string | null {
  try {
    return window.sessionStorage.getItem(draftKey(questionId));
  } catch {
    return null;
  }
}

const label = z.enum(["A", "B", "C", "D"]);
const draftSchema = z.object({
  stemMd: z.string(),
  options: z.array(z.object({ label, textMd: z.string() })).length(4),
  correctLabel: label,
  answerDisplayMd: z.string(),
  explanationMd: z.string(),
  steps: z.array(z.object({ textMd: z.string() })),
  // The row version of the question the draft was started from.
  baseRowVersion: z.number().int(),
});

function parseDraft(raw: string | null): { form: EditFormValues; base: number } | null {
  try {
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { baseRowVersion, ...form } = parsed.data;
    return { form, base: baseRowVersion };
  } catch {
    return null;
  }
}

function writeDraft(questionId: string, form: EditFormValues | null, base = 0): void {
  try {
    if (form) {
      window.sessionStorage.setItem(
        draftKey(questionId),
        JSON.stringify({ ...form, baseRowVersion: base }),
      );
    } else window.sessionStorage.removeItem(draftKey(questionId));
  } catch {
    // Not stored: the edit still works.
  }
}

const optionPath = (index: number) =>
  `options.${String(index)}.textMd` as `options.${number}.textMd`;
const stepPath = (index: number) =>
  `steps.${String(index)}.textMd` as `steps.${number}.textMd`;

const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";
const ICON_BUTTON =
  "inline-flex size-11 items-center justify-center rounded-lg border border-input bg-card text-foreground transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60";
const TEXT_BUTTON = "min-h-11 font-semibold text-primary hover:underline";
const textareaClass = `${inputClass} py-2`;

type Failure =
  | "stale"
  | "notFound"
  | "trashed"
  | "notReady"
  | "regenerating"
  | "signedOut"
  | "invalid"
  | "invalidMath"
  | "generic";

/** A draft of an earlier visit: applied (same version) or only offered (an older version). */
type DraftNotice =
  { kind: "restored"; form: EditFormValues } | { kind: "older"; form: EditFormValues };

/** The live preview of a field's text, rendered with KaTeX. */
function Preview({ children }: { children: ReactNode }) {
  const t = useTranslations("review.edit");
  return (
    <div className="min-w-0 rounded-lg border border-dashed bg-background p-3">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{t("preview")}</p>
      <div className="min-w-0 overflow-x-auto break-words">{children}</div>
    </div>
  );
}

export function QuestionEditor({
  questionId,
  rowVersion,
  initial,
  approved,
  banked,
  returnTo,
}: {
  questionId: string;
  // The row version the page was loaded at: the save is refused when the question moved on.
  rowVersion: number;
  initial: EditInput;
  approved: boolean;
  banked: boolean;
  returnTo: string;
}) {
  const t = useTranslations("review.edit");
  const router = useRouter();
  const base = useId();
  const [saved] = useState(() => toForm(initial));
  // The server render and the first browser render show the saved question; an unsaved draft of
  // an earlier visit is applied right after hydration (see the effect below).
  const form = useForm<EditFormValues, unknown, EditInput>({
    resolver: zodResolver(editFormSchema),
    defaultValues: saved,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: false,
  });
  const { register, setError, reset, control, formState } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;
  const {
    fields: stepFields,
    append,
    remove,
    move,
  } = useFieldArray({
    control,
    name: "steps",
    keyName: "fieldKey",
  });
  const values = useWatch({ control });
  const formRef = useRef<HTMLFormElement>(null);
  const [serverRefusals, setServerRefusals] = useState(0);
  useFocusFirstInvalid(formRef, submitCount + serverRefusals);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [leaving, setLeaving] = useState(false);

  // The unsaved draft of an earlier visit is read once, on the browser after hydration (the
  // server has no sessionStorage). Undefined until read; null when there is none to show.
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const [draftNotice, setDraftNotice] = useState<DraftNotice | null | undefined>(
    undefined,
  );
  if (hydrated && draftNotice === undefined) {
    const draft = parseDraft(readRawDraft(questionId));
    setDraftNotice(
      !draft || sameForm(draft.form, saved)
        ? null
        : // A draft started on another version is never applied silently, only offered.
          { kind: draft.base === rowVersion ? "restored" : "older", form: draft.form },
    );
  }
  // A same-version draft is applied against the saved question (keepDefaultValues), so "changed"
  // still means "differs from what is saved".
  useEffect(() => {
    if (draftNotice?.kind === "restored") {
      reset(draftNotice.form, { keepDefaultValues: true });
    }
  }, [draftNotice, reset]);

  // The draft follows the form. Nothing is written (or cleared) before the form first differs
  // from the saved question, so an older draft waiting to be offered is not wiped on mount.
  const armed = useRef(false);
  useEffect(() => {
    if (!isDirty && !armed.current) return;
    armed.current = true;
    writeDraft(questionId, isDirty ? form.getValues() : null, rowVersion);
  }, [values, isDirty, questionId, rowVersion, form]);

  const clearNotices = () => {
    setFailure(null);
    setDraftNotice(null);
  };

  const discard = () => {
    writeDraft(questionId, null);
    reset(saved);
    clearNotices();
  };

  const useOlderDraft = () => {
    if (draftNotice?.kind !== "older") return;
    reset(draftNotice.form, { keepDefaultValues: true });
    setDraftNotice(null);
  };

  const onValid = async () => {
    setFailure(null);
    let result: EditQuestionResult;
    try {
      // The values as the form holds them: the action parses them with the same schema.
      result = await editQuestionAction({
        questionId,
        expectedRowVersion: rowVersion,
        content: form.getValues(),
      });
    } catch {
      result = { ok: false, reason: "generic" };
    }
    if (result.ok) {
      writeDraft(questionId, null);
      setLeaving(true);
      router.push(returnTo);
      return;
    }
    if (
      (result.reason === "invalid" || result.reason === "invalid_math") &&
      result.fields.length > 0
    ) {
      const message = result.reason === "invalid_math" ? "math" : "invalid";
      for (const path of result.fields) {
        // The server's paths are the form's own names; a refusal of the step count is the list's.
        setError(path === "steps" ? "root.steps" : (path as FieldPath<EditFormValues>), {
          type: "server",
          message,
        });
      }
      setServerRefusals((count) => count + 1);
      setFailure(result.reason === "invalid_math" ? "invalidMath" : "invalid");
      return;
    }
    setFailure(
      result.reason === "not_found"
        ? "notFound"
        : result.reason === "signed_out"
          ? "signedOut"
          : result.reason === "not_ready"
            ? "notReady"
            : result.reason === "invalid" || result.reason === "invalid_math"
              ? "generic"
              : result.reason,
    );
  };
  const onSubmit = form.handleSubmit(onValid, () => {
    setFailure("invalid");
  });

  /** The text of a field's error: the server's "math" refusal, else a bad or empty value. */
  const errorText = (name: string): string | undefined => {
    const error: unknown = get(errors, name);
    if (!error) return undefined;
    return (error as { message?: unknown }).message === "math"
      ? t("fieldMath")
      : t("fieldInvalid");
  };
  const stepsError =
    errors.steps?.root || errors.root?.steps ? t("fieldInvalid") : undefined;

  const ids = {
    stem: `${base}-stem`,
    answer: `${base}-answer`,
    explanation: `${base}-explanation`,
    steps: `${base}-steps`,
  };
  const optionTexts = values.options ?? [];
  const stepTexts = values.steps ?? [];
  const atStepLimit = stepFields.length >= EDIT_LIMITS.maxSteps;

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-w-0 flex-col gap-6"
      onChange={clearNotices}
      onSubmit={(event) => {
        event.preventDefault();
        if (isDirty && !isSubmitting && !leaving) void onSubmit(event);
      }}
    >
      <p className="rounded-lg border bg-accent/60 p-3 text-sm font-medium text-secondary-foreground">
        {banked
          ? t("notices.banked")
          : approved
            ? t("notices.approved")
            : t("notices.checks")}
      </p>

      {draftNotice?.kind === "restored" && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card p-3 text-sm"
        >
          <span>{t("draftRestored")}</span>
          <button type="button" onClick={discard} className={TEXT_BUTTON}>
            {t("discardDraft")}
          </button>
        </p>
      )}

      {draftNotice?.kind === "older" && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card p-3 text-sm"
        >
          <span>{t("draftOlder")}</span>
          <button type="button" onClick={useOlderDraft} className={TEXT_BUTTON}>
            {t("useDraft")}
          </button>
          <button type="button" onClick={discard} className={TEXT_BUTTON}>
            {t("discardDraft")}
          </button>
        </p>
      )}

      {failure && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-destructive bg-card p-3 text-sm font-medium text-destructive"
        >
          <span>{t(`errors.${failure}`)}</span>
          {failure === "stale" && (
            <button
              type="button"
              onClick={() => {
                setFailure(null);
                router.refresh();
              }}
              className={TEXT_BUTTON}
            >
              {t("reload")}
            </button>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <Field id={ids.stem} label={t("stem")} error={errorText("stemMd")}>
          {(a11y) => (
            <textarea
              id={ids.stem}
              {...register("stemMd")}
              defaultValue={saved.stemMd}
              rows={4}
              maxLength={EDIT_LIMITS.stem}
              {...a11y}
              className={textareaClass}
            />
          )}
        </Field>
        <Preview>
          <MathText text={values.stemMd ?? ""} />
        </Preview>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-4">
        <legend className="mb-1 font-heading text-sm font-semibold">
          {t("options")}
        </legend>
        {saved.options.map((option, index) => {
          const id = `${base}-option-${option.label}`;
          return (
            <div key={option.label} className="flex min-w-0 items-start gap-3">
              <input
                type="radio"
                {...register("correctLabel")}
                value={option.label}
                defaultChecked={saved.correctLabel === option.label}
                aria-label={t("keyOption", { label: option.label })}
                className="mt-3 size-6 shrink-0 accent-primary"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Field
                  id={id}
                  label={t("optionLabel", { label: option.label })}
                  error={errorText(optionPath(index))}
                >
                  {(a11y) => (
                    <input
                      id={id}
                      type="text"
                      {...register(optionPath(index))}
                      defaultValue={option.textMd}
                      maxLength={EDIT_LIMITS.option}
                      {...a11y}
                      className={inputClass}
                    />
                  )}
                </Field>
                <Preview>
                  <MathText text={optionTexts[index]?.textMd ?? ""} />
                </Preview>
              </div>
            </div>
          );
        })}
      </fieldset>

      <div className="flex min-w-0 flex-col gap-2">
        <Field id={ids.answer} label={t("answer")} error={errorText("answerDisplayMd")}>
          {(a11y) => (
            <input
              id={ids.answer}
              type="text"
              {...register("answerDisplayMd")}
              defaultValue={saved.answerDisplayMd}
              maxLength={EDIT_LIMITS.option}
              {...a11y}
              className={inputClass}
            />
          )}
        </Field>
        <Preview>
          <MathText text={values.answerDisplayMd ?? ""} />
        </Preview>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <Field
          id={ids.explanation}
          label={t("explanation")}
          error={errorText("explanationMd")}
        >
          {(a11y) => (
            <textarea
              id={ids.explanation}
              {...register("explanationMd")}
              defaultValue={saved.explanationMd}
              rows={4}
              maxLength={EDIT_LIMITS.explanation}
              {...a11y}
              className={textareaClass}
            />
          )}
        </Field>
        <Preview>
          <MathText text={values.explanationMd ?? ""} />
        </Preview>
      </div>

      <fieldset
        aria-describedby={`${ids.steps}-hint`}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="mb-1 font-heading text-sm font-semibold">{t("steps")}</legend>
        <p id={`${ids.steps}-hint`} className="text-sm text-muted-foreground">
          {t("stepsHint", { limit: EDIT_LIMITS.maxSteps })}
        </p>
        {stepsError && <p className="text-sm text-destructive">{stepsError}</p>}
        <ol className="flex min-w-0 flex-col gap-3">
          {stepFields.map((field, index) => {
            const number = index + 1;
            const id = `${ids.steps}-${field.fieldKey}`;
            return (
              <li key={field.fieldKey} className="flex min-w-0 flex-col gap-2">
                <Field
                  id={id}
                  label={t("stepLabel", { number })}
                  error={errorText(stepPath(index))}
                >
                  {(a11y) => (
                    <textarea
                      id={id}
                      {...register(stepPath(index))}
                      defaultValue={field.textMd}
                      rows={2}
                      maxLength={EDIT_LIMITS.step}
                      {...a11y}
                      className={textareaClass}
                    />
                  )}
                </Field>
                <Preview>
                  <MathText text={stepTexts[index]?.textMd ?? ""} />
                </Preview>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={t("moveStepUp", { number })}
                    disabled={index === 0}
                    onClick={() => {
                      clearNotices();
                      move(index, index - 1);
                    }}
                    className={ICON_BUTTON}
                  >
                    <ArrowUp aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("moveStepDown", { number })}
                    disabled={index === stepFields.length - 1}
                    onClick={() => {
                      clearNotices();
                      move(index, index + 1);
                    }}
                    className={ICON_BUTTON}
                  >
                    <ArrowDown aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("removeStep", { number })}
                    onClick={() => {
                      clearNotices();
                      remove(index);
                    }}
                    className={ICON_BUTTON}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          disabled={atStepLimit}
          onClick={() => {
            clearNotices();
            append({ textMd: "" });
          }}
          className={`${BUTTON} self-start border border-input bg-card text-foreground hover:bg-secondary`}
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("addStep")}
        </button>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          disabled={isSubmitting || leaving}
          onClick={() => {
            // Leaving on purpose throws the draft away; closing the tab by accident keeps it.
            writeDraft(questionId, null);
            router.push(returnTo);
          }}
          className={`${BUTTON} border border-input bg-card text-foreground hover:bg-secondary`}
        >
          {t("cancel")}
        </button>
        <SubmitButton
          pending={isSubmitting || leaving}
          disabled={!isDirty}
          label={t("save")}
          pendingLabel={t("saving")}
          className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary-hover`}
        />
      </div>
    </form>
  );
}
