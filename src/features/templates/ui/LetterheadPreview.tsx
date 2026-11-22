import { School } from "lucide-react";
import { useTranslations } from "next-intl";
import type { PaperSize, TemplateFont } from "../schema/template";

const FONT_FAMILIES: Record<TemplateFont, string> = {
  times: '"Times New Roman", Times, serif',
  arial: "Arial, Helvetica, sans-serif",
};

/**
 * A miniature of the letterhead: logo, header lines, the school name and a double rule, in the
 * template's font. The logo comes from the owner-checked route (`logoSrc`), never a public URL.
 * Pure: the form passes what is being typed, so the preview follows it.
 */
export function LetterheadPreview({
  schoolName,
  headerLines,
  subject,
  font,
  paperSize,
  logoSrc,
}: {
  schoolName: string;
  headerLines: readonly string[];
  subject: string;
  font: TemplateFont;
  paperSize: PaperSize;
  logoSrc: string | null;
}) {
  const t = useTranslations("settings.templates");
  const school = schoolName.trim();
  const lines = headerLines.map((line) => line.trim()).filter((line) => line !== "");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="font-heading text-sm font-semibold">{t("preview.heading")}</p>
      <figure
        aria-label={t("preview.label")}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-foreground shadow-card"
        style={{ fontFamily: FONT_FAMILIES[font] }}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden">
            {logoSrc ? (
              // An owner-only route; next/image would need a loader for it and adds nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt={t("preview.logoAlt")}
                className="max-h-14 max-w-14 object-contain"
              />
            ) : (
              <School aria-hidden className="size-9 text-muted-foreground" />
            )}
          </div>
          <div className="flex min-w-0 grow flex-col text-center leading-tight">
            {lines.map((line, index) => (
              <span key={index} className="text-xs font-bold break-words uppercase">
                {line}
              </span>
            ))}
            <span
              className={`text-base font-bold break-words ${school ? "" : "text-muted-foreground"}`}
            >
              {school || t("preview.schoolPlaceholder")}
            </span>
          </div>
          {/* Keeps the text centred on the page, as on the printed letterhead. */}
          <div aria-hidden className="size-14 shrink-0" />
        </div>
        <div aria-hidden className="border-t-[3px] border-double border-foreground" />
        <p className="text-sm">{t("preview.subject", { subject })}</p>
      </figure>
      <p className="text-xs text-muted-foreground">
        {t(`paper.${paperSize}`)} · {t(`fonts.${font}`)}
      </p>
    </div>
  );
}
