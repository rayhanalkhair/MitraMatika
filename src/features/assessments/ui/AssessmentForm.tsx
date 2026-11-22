"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Field } from "@/components/forms/Field";
import { inputClass } from "@/components/forms/field-styles";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { formDataOf } from "@/lib/forms/form-data";
import { useActionForm } from "@/lib/forms/use-action-form";
import { createAssessmentAction } from "../actions/create-assessment";
import { updateAssessmentAction } from "../actions/update-assessment";
import {
  ASSESSMENT_GRADES,
  ASSESSMENT_KINDS,
  ASSESSMENT_LIMITS,
  asFieldKey,
  createAssessmentFormSchema,
  updateAssessmentFormSchema,
  type AssessmentField,
  type AssessmentFormFields,
  type AssessmentFormState,
} from "../schema/assessment";
import { primaryButton } from "./styles";

export interface AssessmentFormValues {
  title: string;
  kind: string;
  grade: number;
  templateId: string | null;
  examDate: string | null;
  durationMinutes: number | null;
  instructions: string | null;
}

export interface TemplateOption {
  id: string;
  name: string;
  isDefault: boolean;
}

const INITIAL_STATE: AssessmentFormState = {};

/**
 * The form's values when it opens: the saved details, or the defaults of a new assessment. A saved
 * template that is no longer among the options (deleted) opens as "none", so the select and the
 * form state agree.
 */
function assessmentFormDefaults(
  templates: TemplateOption[],
  existing?: AssessmentFormValues,
): AssessmentFormFields {
  const templateId = existing?.templateId ?? "";
  return {
    title: existing?.title ?? "",
    kind: existing?.kind ?? "latihan",
    grade: String(existing?.grade ?? 8),
    templateId: templates.some((template) => template.id === templateId)
      ? templateId
      : "",
    examDate: existing?.examDate ?? "",
    durationMinutes:
      existing?.durationMinutes === null ? "" : String(existing?.durationMinutes ?? ""),
    instructions: existing?.instructions ?? "",
  };
}

/**
 * The assessment's fields. Without `existing` it creates one (title, type, grade, template) and the
 * server action sends the teacher to the editor. With `existing` it saves all the details under the
 * row version the page was rendered with; the editor remounts it on a newer one.
 */
export function AssessmentForm({
  templates,
  existing,
  assessmentId,
  rowVersion,
  disabled = false,
  savedNotice = false,
  onSubmitted,
}: {
  templates: TemplateOption[];
  existing?: AssessmentFormValues;
  assessmentId?: string;
  rowVersion?: number;
  disabled?: boolean;
  /** The editor keeps the "saved" notice: a save bumps the row version and remounts this form. */
  savedNotice?: boolean;
  /** Told when the teacher submits, so the editor can tell its own save from a remount. */
  onSubmitted?: () => void;
}) {
  const t = useTranslations("assessments");
  const kinds = useTranslations("assessments.kinds");
  const id = useId();
  const editing = existing !== undefined && assessmentId !== undefined;
  const initial = assessmentFormDefaults(templates, existing);
  // Validated in the browser with React Hook Form over the form's schema; the Server Action parses
  // the posted FormData with the same one. Submitted by hand, so a refused save keeps the input.
  const { form, formRef, state, pending, onSubmit } = useActionForm({
    schema: editing ? updateAssessmentFormSchema : createAssessmentFormSchema,
    defaultValues: initial,
    action: editing ? updateAssessmentAction : createAssessmentAction,
    initialState: INITIAL_STATE,
    toPayload: (_values, element) => formDataOf(element),
    fieldErrorsOf: (current) => current.fieldErrors,
    onSubmitted,
  });
  const { register } = form;
  const { errors } = form.formState;
  // Client errors carry the schema's keys, server errors the action's: the same set.
  const fieldError = (name: AssessmentField) => {
    const message = errors[name]?.message;
    return message ? t(`form.fieldErrors.${asFieldKey(message)}`) : undefined;
  };
  const off = disabled || pending;
  const defaultTemplate = templates.find((template) => template.isDefault);

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      className="flex min-w-0 flex-col gap-4"
    >
      {editing && (
        <>
          <input type="hidden" name="assessmentId" value={assessmentId} />
          <input type="hidden" name="expectedRowVersion" value={rowVersion} />
        </>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field id={`${id}-title`} label={t("form.title")} error={fieldError("title")}>
            {(a11y) => (
              // Every registered control carries `defaultValue` next to `register`: the registration
              // fills the value only once the page runs JavaScript, and the server render shows the
              // saved details.
              <input
                id={`${id}-title`}
                {...register("title")}
                required
                maxLength={ASSESSMENT_LIMITS.title}
                defaultValue={initial.title}
                disabled={off}
                {...a11y}
                className={inputClass}
              />
            )}
          </Field>
        </div>
        <Field id={`${id}-kind`} label={t("form.kind")} error={fieldError("kind")}>
          {(a11y) => (
            <select
              id={`${id}-kind`}
              {...register("kind")}
              defaultValue={initial.kind}
              disabled={off}
              {...a11y}
              className={inputClass}
            >
              {ASSESSMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kinds(kind)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${id}-grade`} label={t("form.grade")} error={fieldError("grade")}>
          {(a11y) => (
            <select
              id={`${id}-grade`}
              {...register("grade")}
              defaultValue={initial.grade}
              disabled={off}
              {...a11y}
              className={inputClass}
            >
              {ASSESSMENT_GRADES.map((grade) => (
                <option key={grade} value={grade}>
                  {t("form.gradeOption", { grade })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field
            id={`${id}-template`}
            label={t("form.template")}
            hint={t("form.templateHint")}
            error={fieldError("templateId")}
          >
            {(a11y) => (
              <select
                id={`${id}-template`}
                {...register("templateId")}
                defaultValue={initial.templateId}
                disabled={off}
                {...a11y}
                className={inputClass}
              >
                <option value="">
                  {existing || !defaultTemplate
                    ? t("form.templateNone")
                    : t("form.templateDefault", { name: defaultTemplate.name })}
                </option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {editing && (
          <>
            <Field
              id={`${id}-date`}
              label={t("form.examDate")}
              error={fieldError("examDate")}
            >
              {(a11y) => (
                <input
                  id={`${id}-date`}
                  {...register("examDate")}
                  type="date"
                  defaultValue={initial.examDate}
                  disabled={off}
                  {...a11y}
                  className={inputClass}
                />
              )}
            </Field>
            <Field
              id={`${id}-duration`}
              label={t("form.duration")}
              error={fieldError("durationMinutes")}
            >
              {(a11y) => (
                <input
                  id={`${id}-duration`}
                  {...register("durationMinutes")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={ASSESSMENT_LIMITS.durationMinutes}
                  defaultValue={initial.durationMinutes}
                  disabled={off}
                  {...a11y}
                  className={inputClass}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field
                id={`${id}-instructions`}
                label={t("form.instructions")}
                error={fieldError("instructions")}
              >
                {(a11y) => (
                  <textarea
                    id={`${id}-instructions`}
                    {...register("instructions")}
                    rows={4}
                    maxLength={ASSESSMENT_LIMITS.instructions}
                    defaultValue={initial.instructions}
                    disabled={off}
                    {...a11y}
                    className={`${inputClass} py-3`}
                  />
                )}
              </Field>
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          pending={pending}
          disabled={disabled}
          label={editing ? t("form.save") : t("form.create")}
          pendingLabel={editing ? t("form.saving") : t("form.creating")}
          className={primaryButton}
        />
        {/* Always mounted so a result is announced when it appears. */}
        <p role="status" className="text-sm font-medium text-success-foreground">
          {(state.savedAt !== undefined || savedNotice) && !state.error
            ? t("form.saved")
            : ""}
        </p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t(`errors.${state.error}`)}
        </p>
      )}
    </form>
  );
}
