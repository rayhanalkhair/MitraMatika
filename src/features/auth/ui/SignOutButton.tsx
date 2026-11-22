import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";
import { signOutAction } from "@/features/auth/actions/actions";

export function SignOutButton() {
  const t = useTranslations("auth");
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
      >
        <LogOut className="size-5 shrink-0" aria-hidden="true" />
        <span>{t("signOut")}</span>
      </button>
    </form>
  );
}
