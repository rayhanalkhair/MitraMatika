import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { linkClass, submitClass } from "@/components/forms/field-styles";
import { signOutAction } from "../actions/actions";
import { AuthCard } from "./AuthCard";

const secondaryClass =
  "inline-flex min-h-12 w-full items-center justify-center rounded-lg border border-border bg-card px-6 font-heading text-base font-semibold transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * What a signed-in account sees while its email is not approved (ADR-0022): who it is, that the
 * admin was told, and the only things it may do: check again, sign out, delete the account
 * (`deleteAccount` is the settings feature's dialog, handed in by the page) and read the privacy
 * notice. Minimal chrome, no app shell.
 */
export function WaitingApproval({
  email,
  deleteAccount,
}: {
  email: string;
  deleteAccount: ReactNode;
}) {
  const t = useTranslations("approval");
  return (
    <AuthCard
      title={t("title")}
      description={t("body")}
      footer={
        <Link href="/privacy" className={linkClass}>
          {t("privacy")}
        </Link>
      }
    >
      <p className="text-sm font-medium break-all">{`${t("account")}: ${email}`}</p>
      <p className="text-sm text-muted-foreground">{t("adminNotified")}</p>
      <div className="flex flex-col gap-3">
        <Link href="/home" className={submitClass}>
          {t("recheck")}
        </Link>
        <form action={signOutAction}>
          <button type="submit" className={secondaryClass}>
            {t("signOut")}
          </button>
        </form>
      </div>
      {deleteAccount}
    </AuthCard>
  );
}
