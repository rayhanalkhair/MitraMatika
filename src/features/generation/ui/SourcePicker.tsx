"use client";

import { useId } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { GenerationMaterial } from "@/features/generation/service/material-selection";
import type { MaterialScope } from "@/features/generation/schema/material-selection";
import type { GenerationFormValues } from "@/features/generation/schema/request-input";
import { choiceClass } from "./choice-class";

const SCOPES: MaterialScope[] = ["all", "sections", "pages"];

const fieldClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-base transition-colors duration-150 aria-invalid:border-destructive";
const labelClass = "font-heading text-sm font-semibold";

/**
 * "Sumber soal": the curriculum topic alone, or "Dari materi" (a material, then its whole text,
 * chosen chapters or a page list). Submits `source`, and for a material `materialId`,
 * `materialScope` and `sectionIds` or `pages`; the server checks everything again. Its inputs are
 * fields of the generation form (React Hook Form): it must sit inside that form's provider.
 */
export function SourcePicker({
  materials,
  errorId,
  truncated = false,
}: {
  materials: GenerationMaterial[];
  // More materials exist than the newest 100 listed.
  truncated?: boolean;
  // The id of the material error message, when there is one.
  errorId?: string;
}) {
  const t = useTranslations("generate.source");
  const id = useId();
  const { register, setValue, control, formState } =
    useFormContext<GenerationFormValues>();
  const [source, materialId, scope] = useWatch({
    control,
    name: ["source", "materialId", "materialScope"],
  });
  // The server render, before React Hook Form fills the inputs, checks the starting choices.
  const initial = formState.defaultValues;
  const material = materials.find((candidate) => candidate.id === materialId);
  const invalid = errorId !== undefined;
  const pagesHintId = `${id}-pages-hint`;

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t("legend")}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["topic", "material"] as const).map((value) => (
            <div key={value}>
              <input
                type="radio"
                {...register("source")}
                id={`${id}-source-${value}`}
                value={value}
                defaultChecked={initial?.source === value}
                disabled={value === "material" && materials.length === 0}
                className="peer sr-only"
              />
              <label htmlFor={`${id}-source-${value}`} className={choiceClass}>
                {t(value)}
              </label>
            </div>
          ))}
        </div>
        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("none")}{" "}
            <Link
              href="/materials"
              className="font-semibold text-primary underline-offset-4 hover:underline"
            >
              {t("noneLink")}
            </Link>
          </p>
        ) : null}
      </fieldset>

      {source === "material" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("materialHint")}</p>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-material`} className={labelClass}>
              {t("pick")}
            </label>
            <select
              id={`${id}-material`}
              {...register("materialId", {
                // Chapters belong to one material: a new material starts with none chosen.
                onChange: () => {
                  setValue("sectionIds", []);
                },
              })}
              aria-invalid={invalid || undefined}
              aria-describedby={errorId}
              className={fieldClass}
            >
              <option value="">{t("pickPlaceholder")}</option>
              {materials.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            {truncated && (
              <p className="text-sm text-muted-foreground">{t("truncated")}</p>
            )}
          </div>

          {material && (
            <fieldset className="flex flex-col gap-2" aria-describedby={errorId}>
              <legend className={`${labelClass} mb-2`}>{t("scopeLegend")}</legend>
              <div className="grid grid-cols-3 gap-2">
                {SCOPES.map((value) => (
                  <div key={value}>
                    <input
                      type="radio"
                      {...register("materialScope")}
                      id={`${id}-scope-${value}`}
                      value={value}
                      className="peer sr-only"
                    />
                    <label htmlFor={`${id}-scope-${value}`} className={choiceClass}>
                      {t(`scopes.${value}`)}
                    </label>
                  </div>
                ))}
              </div>

              {scope === "sections" &&
                (material.sections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noSections")}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {material.sections.map((section) => (
                      <li key={section.id}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-secondary">
                          <input
                            type="checkbox"
                            {...register("sectionIds")}
                            value={section.id}
                            aria-invalid={invalid || undefined}
                            aria-describedby={errorId}
                            className="size-4 shrink-0 accent-primary"
                          />
                          <span className="min-w-0 break-words">
                            {section.title}{" "}
                            <span className="text-sm text-muted-foreground">
                              (
                              {t("sectionPages", {
                                start: String(section.pageStart),
                                end: String(
                                  section.pageEnd ??
                                    material.pageCount ??
                                    section.pageStart,
                                ),
                              })}
                              )
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ))}

              {scope === "pages" && (
                <div className="flex flex-col gap-2">
                  <label htmlFor={`${id}-pages`} className={labelClass}>
                    {t("pagesLabel")}
                  </label>
                  <input
                    id={`${id}-pages`}
                    {...register("pages")}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-invalid={invalid || undefined}
                    aria-describedby={[pagesHintId, errorId].filter(Boolean).join(" ")}
                    className={fieldClass}
                  />
                  <p id={pagesHintId} className="text-sm text-muted-foreground">
                    {t("pagesHint", { count: String(material.pageCount ?? 0) })}
                  </p>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
