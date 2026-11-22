"use client";

import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { FormProvider, type FieldError } from "react-hook-form";
import { createGenerationRequestAction } from "@/features/generation/actions/create-request";
import { FormError } from "@/components/forms/FormError";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { formDataOf } from "@/lib/forms/form-data";
import { useActionForm } from "@/lib/forms/use-action-form";
import { choiceClass } from "./choice-class";
import { SourcePicker } from "./SourcePicker";
import { StepCard } from "./StepCard";
import type { GenerationMaterial } from "@/features/generation/service/material-selection";
import { TopicErrorContext } from "./topic-error-context";
import {
  initialGenerationState,
  type GenerationFieldName,
} from "@/features/generation/schema/form-state";
import {
  DEFAULT_ERROR_KEYS,
  DIFFICULTIES,
  generationFormDefaults,
  generationFormSchema,
} from "@/features/generation/schema/request-input";

const QUANTITIES = ["1", "2", "3", "4", "5"] as const;

// A change to any "Dari materi" field (or the source itself) re-checks the one material error,
// once the form was submitted; going back to the topic drops it.
const MATERIAL_ERROR = ["material"] as const;
const DEPENDENT_FIELDS = {
  source: MATERIAL_ERROR,
  materialId: MATERIAL_ERROR,
  materialScope: MATERIAL_ERROR,
  sectionIds: MATERIAL_ERROR,
  pages: MATERIAL_ERROR,
};

const submitClass =
  "inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-lg bg-primary px-8 py-3 text-base font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover disabled:opacity-60 md:w-auto md:self-start";

/**
 * Validated in the browser with React Hook Form over `generationFormSchema`; the Server Action
 * parses the posted FormData with the same schema. The topic comes from the picker (`children`,
 * rendered by the page), which sets the form's `topic` value through the form context.
 */
export function GenerationForm({
  children,
  gradeSlot,
  selectedTopic,
  returnTo,
  materials,
  materialsTruncated = false,
}: {
  children: ReactNode;
  gradeSlot?: ReactNode;
  // The topic in the URL when the page rendered (the picker keeps the form in step afterwards).
  selectedTopic: string | null;
  // The teacher's materials ready for "Dari materi"; without it the form has no source step.
  materials?: GenerationMaterial[];
  // More materials exist than the picker lists.
  materialsTruncated?: boolean;
  // The assessment editor this page was opened from (already checked by the page); the action
  // checks it again and keeps it on the status page, so the teacher can go back.
  returnTo?: string;
}) {
  const t = useTranslations("generate");
  const format = useFormatter();
  // Choosing a topic rewrites the URL (router.replace) without returnTo, and the page then renders
  // this form without the prop: keep the first value for as long as the form stays mounted.
  const [back, setBack] = useState(returnTo);
  if (returnTo !== undefined && returnTo !== back) setBack(returnTo);
  const { form, formRef, state, pending, onSubmit } = useActionForm({
    schema: generationFormSchema,
    defaultValues: generationFormDefaults(selectedTopic),
    action: createGenerationRequestAction,
    initialState: initialGenerationState,
    // What the browser would post: the picker's hidden topic, returnTo and the visible branch only.
    toPayload: (_values, element) => formDataOf(element),
    fieldErrorsOf: (current) => current.fieldErrors,
    dependentErrorPaths: DEPENDENT_FIELDS,
  });
  const { register } = form;
  const { errors, defaultValues: initial } = form.formState;

  // `material` is an error of several fields together, not a field of its own.
  const fieldErrors = errors as Partial<Record<GenerationFieldName, FieldError>>;
  const errorText = (field: GenerationFieldName): string | undefined => {
    const message = fieldErrors[field]?.message;
    if (message === undefined) return undefined;
    // Client keys come from the schema, server keys from the action: both are catalog keys.
    type Key = Parameters<typeof t>[0];
    const key = t.has(`errors.${message}` as Key) ? message : DEFAULT_ERROR_KEYS[field];
    return t(`errors.${key}` as Key);
  };
  const topicError = errorText("topic");
  const materialError = errorText("material");
  const countError = errorText("count");
  const difficultyError = errorText("difficulty");
  // The source step comes after the grade when the page offers materials.
  const offset = materials ? 1 : 0;

  return (
    <FormProvider {...form}>
      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col gap-4 sm:gap-6"
      >
        <input type="hidden" name="grade" value="8" />
        {back ? <input type="hidden" name="returnTo" value={back} /> : null}
        <StepCard step={1} title={t("steps.grade")}>
          {gradeSlot}
        </StepCard>

        {materials && (
          <StepCard step={2} title={t("steps.source")}>
            <SourcePicker
              materials={materials}
              truncated={materialsTruncated}
              errorId={materialError ? "error-material" : undefined}
            />
            {materialError && (
              <p id="error-material" role="alert" className="text-sm text-destructive">
                {materialError}
              </p>
            )}
          </StepCard>
        )}

        <StepCard step={2 + offset} title={t("steps.topic")}>
          <TopicErrorContext.Provider value={topicError ? "error-topic" : undefined}>
            {children}
          </TopicErrorContext.Provider>
          {topicError && (
            <p id="error-topic" role="alert" className="text-sm text-destructive">
              {topicError}
            </p>
          )}
        </StepCard>

        <StepCard step={3 + offset} title={t("steps.count")}>
          <fieldset
            aria-describedby={countError ? "error-count" : undefined}
            data-invalid={countError ? "true" : undefined}
            className="flex flex-col gap-2"
          >
            <legend className="sr-only">{t("quantityLegend")}</legend>
            <div className="grid grid-cols-5 gap-2">
              {QUANTITIES.map((n) => (
                <div key={n}>
                  <input
                    type="radio"
                    {...register("count")}
                    id={`count-${n}`}
                    value={n}
                    defaultChecked={initial?.count === n}
                    className="peer sr-only"
                  />
                  <label htmlFor={`count-${n}`} className={choiceClass}>
                    {n}
                  </label>
                </div>
              ))}
            </div>
            {countError && (
              <p id="error-count" role="alert" className="text-sm text-destructive">
                {countError}
              </p>
            )}
          </fieldset>
        </StepCard>

        <StepCard step={4 + offset} title={t("steps.difficulty")}>
          <fieldset
            aria-describedby={difficultyError ? "error-difficulty" : undefined}
            data-invalid={difficultyError ? "true" : undefined}
            className="flex flex-col gap-2"
          >
            <legend className="sr-only">{t("difficultyLegend")}</legend>
            <div className="grid grid-cols-3 gap-2">
              {DIFFICULTIES.map((level) => (
                <div key={level}>
                  <input
                    type="radio"
                    {...register("difficulty")}
                    id={`difficulty-${level}`}
                    value={level}
                    defaultChecked={initial?.difficulty === level}
                    className="peer sr-only"
                  />
                  <label htmlFor={`difficulty-${level}`} className={choiceClass}>
                    {t(`difficulties.${level}`)}
                  </label>
                </div>
              ))}
            </div>
            {difficultyError && (
              <p id="error-difficulty" role="alert" className="text-sm text-destructive">
                {difficultyError}
              </p>
            )}
          </fieldset>
          <p className="text-sm text-muted-foreground">{t("typeNote")}</p>
        </StepCard>

        <FormError message={state.error ? t(`formErrors.${state.error}`) : undefined} />
        {state.activeRequestId && (
          <p
            role="status"
            className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
          >
            {t("activeRequest")}{" "}
            <Link
              href={`/generate/${state.activeRequestId}`}
              className="font-semibold underline underline-offset-4"
            >
              {t("openActiveRequest")}
            </Link>
          </p>
        )}
        {state.dailyLimit && (
          <p
            role="alert"
            className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
          >
            {t("dailyLimit", {
              ...state.dailyLimit,
              time: format.dateTime(new Date(state.dailyLimit.resetsAt), {
                dateStyle: "long",
                timeStyle: "short",
              }),
            })}
          </p>
        )}

        <SubmitButton
          pending={pending}
          label={t("submit")}
          pendingLabel={t("submitting")}
          className={submitClass}
          spinner
        />
      </form>
    </FormProvider>
  );
}
