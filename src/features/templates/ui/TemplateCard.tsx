"use client";

import { FileText, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useState, useTransition } from "react";
import { TrashTemplateButton } from "@/features/trash/ui/TrashTemplateButton";
import { setDefaultTemplateAction } from "../actions/set-default-template";
import type { TemplateView } from "../schema/template";
import { TemplateForm } from "./TemplateForm";

const NEW = "new";
const smallButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 font-heading text-sm font-semibold transition-colors duration-150 disabled:opacity-60";

/** The card when the templates could not be read: no form that could add a duplicate default. */
export function TemplateCardUnavailable() {
  const t = useTranslations("settings.templates");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <h2 id={headingId} className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>
      <p role="alert" className="text-sm text-destructive">
        {t("loadFailed")}
      </p>
    </section>
  );
}

/**
 * Settings > Templat dokumen (decision 7): the teacher's templates (the default one marked, each
 * with a move-to-trash button), the form of the chosen one with its live letterhead preview, and a
 * new-template form. Takes plain
 * data only, so it can sit under the server page.
 */
export function TemplateCard({ templates }: { templates: TemplateView[] }) {
  const t = useTranslations("settings.templates");
  const headingId = useId();
  const descriptionId = useId();
  const [selectedId, setSelectedId] = useState<string>(templates[0]?.id ?? NEW);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [pending, startTransition] = useTransition();
  // A selected template that left the list (moved to the trash) hands over to the first one left.
  const selected =
    templates.find((template) => template.id === selectedId) ??
    (selectedId === NEW ? null : (templates[0] ?? null));

  const onSaved = useCallback((message: string, templateId?: string) => {
    setProblem("");
    setNotice(message);
    if (templateId) setSelectedId(templateId);
  }, []);

  function makeDefault(templateId: string) {
    setNotice("");
    setProblem("");
    startTransition(async () => {
      const result = await setDefaultTemplateAction(templateId);
      if (result.ok) setNotice(t("defaultSaved"));
      else if (result.reason === "unauthenticated")
        setProblem(t("formErrors.unauthenticated"));
      else setProblem(t("setDefaultFailed"));
    });
  }

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className="flex min-w-0 flex-col gap-5 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="font-heading text-lg font-bold">
          {t("heading")}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {t("description")}
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <ul aria-label={t("listLabel")} className="flex flex-col gap-2">
          {templates.map((template) => (
            <li
              key={template.id}
              className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 ${
                template.id === selected?.id
                  ? "border-primary bg-accent"
                  : "border-border"
              }`}
            >
              <FileText aria-hidden className="size-5 shrink-0 text-primary" />
              <div className="flex min-w-0 grow flex-col">
                <span className="font-heading text-sm font-semibold break-words">
                  {template.name}
                </span>
                <span className="text-sm break-words text-muted-foreground">
                  {template.schoolName}
                </span>
              </div>
              {template.isDefault ? (
                <span className="rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground">
                  {t("defaultBadge")}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    makeDefault(template.id);
                  }}
                  aria-label={t("makeDefault", { name: template.name })}
                  className={`${smallButtonClass} text-primary hover:bg-muted`}
                >
                  {t("makeDefaultShort")}
                </button>
              )}
              <button
                type="button"
                aria-pressed={template.id === selected?.id}
                aria-label={t("edit", { name: template.name })}
                onClick={() => {
                  setNotice("");
                  setSelectedId(template.id);
                }}
                className={`${smallButtonClass} border border-border bg-card hover:bg-muted`}
              >
                {t("editShort")}
              </button>
              <TrashTemplateButton templateId={template.id} name={template.name} />
            </li>
          ))}
        </ul>
      )}

      {templates.length > 0 && (
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => {
            setNotice("");
            setSelectedId(NEW);
          }}
          className={`${smallButtonClass} self-start border border-border bg-card text-primary hover:bg-muted`}
        >
          <Plus aria-hidden className="size-4" />
          {t("newTemplate")}
        </button>
      )}

      {/* Always mounted (not display:none when empty) so the first notice is announced. */}
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      <TemplateForm key={selected?.id ?? NEW} template={selected} onSaved={onSaved} />
    </section>
  );
}
