import { useTranslations } from "next-intl";
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type SubmitEvent,
} from "react";
import { useWatch, type Control } from "react-hook-form";
import { Field } from "@/components/forms/Field";
import { inputClass, submitClass } from "@/components/forms/field-styles";
import { FormError } from "@/components/forms/FormError";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { TextField } from "@/components/forms/TextField";
import { formDataOf } from "@/lib/forms/form-data";
import { useActionForm } from "@/lib/forms/use-action-form";
import { saveTemplateAction } from "../actions/save-template";
import { uploadLogoAction } from "../actions/upload-logo";
import {
  asFieldKey,
  DEFAULT_SUBJECT,
  FONTS,
  HEADER_LINE_FIELDS,
  LOGO_ACCEPT,
  MAX_LOGO_BYTES,
  PAPER_SIZES,
  STUDENT_FIELDS,
  TEMPLATE_LIMITS,
  templateFormSchema,
  type LogoErrorKey,
  type LogoFormState,
  type PaperSize,
  type TemplateField,
  type TemplateFont,
  type TemplateFormState,
  type TemplateFormValues,
  type TemplateInput,
  type TemplateView,
} from "../schema/template";
import { LetterheadPreview } from "./LetterheadPreview";

const labelClass = "font-heading text-sm font-semibold";
const checkLabelClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-sm";
const checkboxClass = "size-5 shrink-0 accent-primary";

const INITIAL_STATE: TemplateFormState = {};

const logoSrc = (template: TemplateView | null) =>
  template?.hasLogo
    ? `/api/templates/${template.id}/logo?v=${String(template.rowVersion)}`
    : null;

/** The logo upload of a saved template: its own form, next to the template form. */
function LogoForm({
  template,
  onSaved,
}: {
  template: TemplateView;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("settings.templates");
  const [state, formAction, pending] = useActionState<LogoFormState, FormData>(
    uploadLogoAction,
    {},
  );
  const [localError, setLocalError] = useState<LogoErrorKey | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const error = localError ?? state.error;

  useEffect(() => {
    if (state.savedAt !== undefined) onSaved(t("logo.saved"));
  }, [state.savedAt, onSaved, t]);
  useEffect(() => {
    if (error) inputRef.current?.focus();
  }, [error, state]);

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    // The same limits as the server, checked before the upload starts.
    if (!file || file.size === 0) {
      setLocalError("empty");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLocalError("tooLarge");
      return;
    }
    setLocalError(null);
    const data = new FormData(event.currentTarget);
    startTransition(() => {
      formAction(data);
    });
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 rounded-lg bg-muted p-4"
    >
      <input type="hidden" name="templateId" value={template.id} />
      <Field
        id={`${id}-logo`}
        label={t("logo.label")}
        hint={t("logo.hint")}
        error={error ? t(`logo.errors.${error}`) : undefined}
      >
        {(a11y) => (
          <input
            ref={inputRef}
            id={`${id}-logo`}
            name="logo"
            type="file"
            accept={LOGO_ACCEPT}
            {...a11y}
            onChange={() => {
              setLocalError(null);
            }}
            className="min-h-11 w-full min-w-0 text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-card file:px-4 file:font-semibold file:text-primary"
          />
        )}
      </Field>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="inline-flex min-h-11 items-center justify-center self-start rounded-lg border border-border bg-card px-4 font-heading text-sm font-semibold text-primary transition-colors duration-150 hover:bg-accent disabled:opacity-60"
      >
        {t("logo.submit")}
      </button>
    </form>
  );
}

const asPaperSize = (value: string): PaperSize =>
  PAPER_SIZES.find((size) => size === value) ?? "A4";
const asFont = (value: string): TemplateFont =>
  FONTS.find((font) => font === value) ?? "times";

/** The form's values when it opens: the saved template, or a new one with the usual defaults. */
function templateFormDefaults(template: TemplateView | null): TemplateFormValues {
  return {
    name: template?.name ?? "",
    schoolName: template?.schoolName ?? "",
    headerLine0: template?.headerLines[0] ?? "",
    headerLine1: template?.headerLines[1] ?? "",
    headerLine2: template?.headerLines[2] ?? "",
    headerLine3: template?.headerLines[3] ?? "",
    subject: template?.subject ?? DEFAULT_SUBJECT,
    studentFields: template ? [...template.studentFields] : [...STUDENT_FIELDS],
    defaultInstructions: template?.defaultInstructions ?? "",
    paperSize: template?.paperSize ?? "A4",
    font: template?.font ?? "times",
    isDefault: false,
  };
}

/** The letterhead as typed: only this part re-renders on every keystroke. */
function LivePreview({
  control,
  logo,
}: {
  control: Control<TemplateFormValues, unknown, TemplateInput>;
  logo: string | null;
}) {
  const [schoolName, line0, line1, line2, line3, subject, paperSize, font] = useWatch({
    control,
    name: ["schoolName", ...HEADER_LINE_FIELDS, "subject", "paperSize", "font"] as const,
  });
  return (
    <LetterheadPreview
      schoolName={schoolName}
      headerLines={[line0, line1, line2, line3]}
      subject={subject.trim() || DEFAULT_SUBJECT}
      font={asFont(font)}
      paperSize={asPaperSize(paperSize)}
      logoSrc={logo}
    />
  );
}

/**
 * Creates (template null) or edits a template. Validated in the browser with React Hook Form over
 * `templateFormSchema`; the Server Action parses the posted FormData with the same schema. The
 * template id and row version are hidden inputs outside the form's values. Submitted by hand, so a
 * refused save keeps everything that was typed; the letterhead preview watches the typed values.
 */
export function TemplateForm({
  template,
  onSaved,
}: {
  template: TemplateView | null;
  onSaved: (message: string, templateId?: string) => void;
}) {
  const t = useTranslations("settings.templates");
  const tWorking = useTranslations("auth");
  const initial = templateFormDefaults(template);
  const { form, formRef, state, pending, onSubmit } = useActionForm({
    schema: templateFormSchema,
    defaultValues: initial,
    action: saveTemplateAction,
    initialState: INITIAL_STATE,
    toPayload: (_values, element) => formDataOf(element),
    fieldErrorsOf: (current) => current.fieldErrors,
  });
  // The fields carry `defaultValue` / `defaultChecked` next to `register` on purpose: React Hook
  // Form fills them only after hydration, so the server render (and a browser without JavaScript)
  // would show empty fields without them.
  const { register } = form;
  const { errors } = form.formState;
  const id = useId();
  const headingId = useId();

  useEffect(() => {
    if (state.savedAt !== undefined) onSaved(t("saved"), state.templateId);
  }, [state.savedAt, state.templateId, onSaved, t]);

  // Client errors carry the schema's keys, server errors the action's: the same set.
  const fieldError = (field: TemplateField) => {
    const message = errors[field]?.message;
    return message ? t(`fieldErrors.${asFieldKey(message)}`) : undefined;
  };

  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 grid-cols-1 items-start gap-6 border-t border-border pt-5 lg:grid-cols-12"
    >
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-7">
        <h3 id={headingId} className="font-heading text-base font-semibold">
          {template ? t("editHeading") : t("newHeading")}
        </h3>
        <form
          ref={formRef}
          onSubmit={onSubmit}
          noValidate
          className="flex min-w-0 flex-col gap-4"
        >
          {template && (
            <>
              <input type="hidden" name="templateId" value={template.id} />
              <input
                type="hidden"
                name="expectedRowVersion"
                value={template.rowVersion}
              />
            </>
          )}
          <TextField
            id={`${id}-name`}
            label={t("fields.name")}
            hint={t("fields.nameHint")}
            autoComplete="off"
            maxLength={TEMPLATE_LIMITS.name}
            registration={register("name")}
            defaultValue={initial.name}
            error={fieldError("name")}
          />
          <TextField
            id={`${id}-school`}
            label={t("fields.schoolName")}
            autoComplete="organization"
            maxLength={TEMPLATE_LIMITS.schoolName}
            registration={register("schoolName")}
            defaultValue={initial.schoolName}
            error={fieldError("schoolName")}
          />
          <fieldset
            aria-describedby={`${id}-lines-hint`}
            className="flex min-w-0 flex-col gap-3"
          >
            <legend className={`${labelClass} mb-2`}>{t("fields.headerLines")}</legend>
            <p id={`${id}-lines-hint`} className="text-sm text-muted-foreground">
              {t("fields.headerLinesHint")}
            </p>
            {HEADER_LINE_FIELDS.map((field, index) => (
              <TextField
                key={field}
                id={`${id}-${field}`}
                label={t("fields.headerLine", { number: index + 1 })}
                autoComplete="off"
                maxLength={TEMPLATE_LIMITS.headerLine}
                registration={register(field)}
                defaultValue={initial[field]}
                error={fieldError(field)}
              />
            ))}
          </fieldset>
          <TextField
            id={`${id}-subject`}
            label={t("fields.subject")}
            autoComplete="off"
            maxLength={TEMPLATE_LIMITS.subject}
            registration={register("subject")}
            defaultValue={initial.subject}
            error={fieldError("subject")}
          />
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className={`${labelClass} mb-2`}>{t("fields.studentFields")}</legend>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {STUDENT_FIELDS.map((field) => (
                <label key={field} className={checkLabelClass}>
                  <input
                    type="checkbox"
                    value={field}
                    {...register("studentFields")}
                    defaultChecked={initial.studentFields.includes(field)}
                    className={checkboxClass}
                  />
                  {t(`studentField.${field}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <Field
            id={`${id}-instructions`}
            label={t("fields.defaultInstructions")}
            error={fieldError("defaultInstructions")}
          >
            {(a11y) => (
              <textarea
                id={`${id}-instructions`}
                {...register("defaultInstructions")}
                rows={3}
                maxLength={TEMPLATE_LIMITS.instructions}
                defaultValue={initial.defaultInstructions}
                {...a11y}
                className={`${inputClass} py-3`}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id={`${id}-paper`}
              label={t("fields.paperSize")}
              error={fieldError("paperSize")}
            >
              {(a11y) => (
                <select
                  id={`${id}-paper`}
                  {...register("paperSize")}
                  defaultValue={initial.paperSize}
                  {...a11y}
                  className={inputClass}
                >
                  {PAPER_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {t(`paper.${size}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`${id}-font`} label={t("fields.font")} error={fieldError("font")}>
              {(a11y) => (
                <select
                  id={`${id}-font`}
                  {...register("font")}
                  defaultValue={initial.font}
                  {...a11y}
                  className={inputClass}
                >
                  {FONTS.map((option) => (
                    <option key={option} value={option}>
                      {t(`fonts.${option}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {!template?.isDefault && (
            <label className={checkLabelClass}>
              <input
                type="checkbox"
                {...register("isDefault")}
                className={checkboxClass}
              />
              {t("fields.isDefault")}
            </label>
          )}
          <FormError message={state.error ? t(`formErrors.${state.error}`) : undefined} />
          <SubmitButton
            pending={pending}
            label={t("submit")}
            pendingLabel={tWorking("working")}
            className={`${submitClass} sm:w-auto sm:self-start`}
          />
        </form>
        {template ? (
          <LogoForm template={template} onSaved={onSaved} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("logo.saveFirst")}</p>
        )}
      </div>
      <div className="min-w-0 lg:sticky lg:top-6 lg:col-span-5">
        <LivePreview control={form.control} logo={logoSrc(template)} />
      </div>
    </section>
  );
}
