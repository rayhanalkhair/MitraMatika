import { useTranslations } from "next-intl";
import { displayNameOf, initialsOf } from "./user-display";

export function TopBar({ user }: { user: { name: string | null; email: string } }) {
  const t = useTranslations("shell");
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:h-16 md:px-8">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-base font-bold text-primary-foreground md:hidden"
      >
        M
      </span>
      <span className="font-heading text-base font-bold tracking-tight md:hidden">
        MitraMatika
      </span>
      <p className="hidden min-w-0 truncate text-sm font-medium text-muted-foreground md:block">
        {t("curriculumContext")}
      </p>
      <span
        role="img"
        aria-label={t("accountAvatar", { name: displayNameOf(user.name, user.email) })}
        className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-heading text-sm font-bold text-accent-foreground"
      >
        {initialsOf(user.name, user.email)}
      </span>
    </header>
  );
}
