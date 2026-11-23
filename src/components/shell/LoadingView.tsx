import { useTranslations } from "next-intl";
import { PageContainer } from "./PageContainer";

const block = "rounded-lg bg-muted motion-safe:animate-pulse";

/**
 * The loading state of a route segment (loading.tsx): one polite, busy status with a text label,
 * and skeleton blocks (title, then cards) that assistive technology skips. The pulse runs only
 * when the visitor allows motion.
 */
export function LoadingView() {
  const t = useTranslations("systemPages");
  return (
    <PageContainer>
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <p className="sr-only">{t("loading")}</p>
        <div data-skeleton aria-hidden="true" className={`${block} h-9 w-1/3`} />
        <div data-skeleton aria-hidden="true" className={`${block} h-5 w-2/3`} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div data-skeleton aria-hidden="true" className={`${block} h-40`} />
          <div data-skeleton aria-hidden="true" className={`${block} h-40`} />
        </div>
        <div data-skeleton aria-hidden="true" className={`${block} h-64`} />
      </div>
    </PageContainer>
  );
}
