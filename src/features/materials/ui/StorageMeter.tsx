import { useFormatter, useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSize } from "./format-size";

/** From this share of the cap on, the meter warns (in words, not colour alone). */
export const NEARLY_FULL = 0.9;

// No "use client": rendered by the materials page (server) and by the upload box (client).
/**
 * The storage meter: what counts toward the 300 MB cap (every kind of file: materials, trashed
 * ones until purged, page pictures, exports, logos, solver photos, and uploads in progress), as
 * text, a meter and one line saying what is counted, with a written warning near the cap.
 */
export function StorageMeter({
  usedBytes,
  capBytes,
}: {
  usedBytes: number;
  capBytes: number;
}) {
  const t = useTranslations("materials");
  const format = useFormatter();
  const share = capBytes > 0 ? Math.min(1, usedBytes / capBytes) : 1;
  const text = t("upload.storage", {
    used: formatSize(usedBytes, format),
    cap: formatSize(capBytes, format),
  });
  const nearlyFull = share >= NEARLY_FULL;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted-foreground">{text}</p>
      <p className="text-sm text-muted-foreground">{t("storage.counted")}</p>
      <div
        role="meter"
        aria-label={t("storage.label")}
        aria-valuemin={0}
        aria-valuemax={capBytes}
        aria-valuenow={Math.min(usedBytes, capBytes)}
        aria-valuetext={text}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            nearlyFull ? "bg-warning-foreground" : "bg-primary",
          )}
          style={{ width: `${String(Math.round(share * 100))}%` }}
        />
      </div>
      {nearlyFull ? (
        <p className="flex items-start gap-2 text-sm font-medium text-warning-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("storage.nearlyFull")}
        </p>
      ) : null}
    </div>
  );
}
