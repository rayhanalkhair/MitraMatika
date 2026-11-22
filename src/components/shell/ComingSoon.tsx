import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";
import { PageContainer } from "./PageContainer";
import { StatusPill } from "@/components/ui/status-pill";

// The placeholder body of a section that is not built yet: an icon, the section name as the page
// heading, a "Segera hadir" pill and one honest paragraph on what the section will do. Text only,
// so there is never sample data on a screen that has no feature behind it.
export function ComingSoon({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  const t = useTranslations("common");
  return (
    <PageContainer width="narrow" className="py-12 sm:py-20">
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-12 text-center shadow-card">
        <span
          aria-hidden="true"
          className="flex size-16 items-center justify-center rounded-lg bg-accent text-primary"
        >
          <Icon className="size-8" />
        </span>
        <h1 className="font-heading text-2xl font-bold text-foreground">{title}</h1>
        <StatusPill tone="neutral">
          <span>{t("comingSoon")}</span>
        </StatusPill>
        <p className="max-w-prose text-muted-foreground">{description}</p>
      </div>
    </PageContainer>
  );
}
