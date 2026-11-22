import { useTranslations } from "next-intl";
import { BookX, TriangleAlert } from "lucide-react";

export function UnavailableNotice({ kind }: { kind: "empty" | "error" }) {
  const t = useTranslations("buatSoal");
  const isError = kind === "error";
  const Icon = isError ? TriangleAlert : BookX;
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
        isError
          ? "border-destructive/30 bg-destructive-soft text-destructive-foreground"
          : "bg-card text-muted-foreground"
      }`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <p>{isError ? t("unavailableError") : t("unavailableEmpty")}</p>
    </div>
  );
}
