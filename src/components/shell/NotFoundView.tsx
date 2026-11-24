import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusScreen } from "./StatusScreen";

const primaryLink =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-primary px-6 font-heading text-base font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover";

/**
 * The 404. It reads no session and names nobody: the one link goes to /home, which sends a
 * signed-out visitor to the sign-in page and a pending account to the waiting page.
 */
export function NotFoundView({ framed }: { framed: boolean }) {
  const t = useTranslations("systemPages.notFound");
  return (
    <StatusScreen title={t("title")} description={t("description")} framed={framed}>
      <Link href="/home" className={primaryLink}>
        {t("home")}
      </Link>
    </StatusScreen>
  );
}
