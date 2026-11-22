import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { isAuthErrorKey, isAuthNoticeKey } from "@/features/auth";
import { AuthCard } from "@/features/auth/ui/AuthCard";
import { linkClass } from "@/components/forms/field-styles";
import { GoogleButton } from "@/features/auth/ui/GoogleButton";
import { OrDivider } from "@/features/auth/ui/OrDivider";
import { SignInForm } from "@/features/auth/ui/SignInForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("title") };
}

export default async function MasukPage({ searchParams }: PageProps<"/sign-in">) {
  const t = await getTranslations("auth");
  const { error, notice } = await searchParams;
  const errorKey = typeof error === "string" && isAuthErrorKey(error) ? error : undefined;
  const noticeKey =
    typeof notice === "string" && isAuthNoticeKey(notice) ? notice : undefined;

  return (
    <AuthCard
      title={t("title")}
      description={t("subtitle")}
      footer={
        <p>
          {t("signIn.noAccount")}{" "}
          <Link href="/sign-up" className={linkClass}>
            {t("signIn.signUpLink")}
          </Link>
        </p>
      }
    >
      {noticeKey && (
        <p
          role="status"
          className="rounded-lg border border-success/40 bg-success-soft p-3 text-sm text-success-foreground"
        >
          {t(`notices.${noticeKey}`)}
          {noticeKey === "linkUsed" && (
            <>
              {" "}
              <Link href="/verify-email" className={linkClass}>
                {t("signIn.resendLink")}
              </Link>
            </>
          )}
        </p>
      )}
      {errorKey && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorKey}`)}
        </p>
      )}
      <GoogleButton />
      <OrDivider label={t("or")} />
      <SignInForm />
    </AuthCard>
  );
}
