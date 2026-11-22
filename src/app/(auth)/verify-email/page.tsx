import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { readPendingEmail, RESEND_COOLDOWN_SECONDS } from "@/features/auth";
import { AuthCard } from "@/features/auth/ui/AuthCard";
import { linkClass } from "@/components/forms/field-styles";
import { VerifyEmailNotice } from "@/features/auth/ui/VerifyEmailNotice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("verify.title") };
}

// Two ways in: right after sign-up (or an unverified sign-in), when a link has just been sent, so
// the resend starts on its countdown; and from a verification link that failed (?error=, through
// /auth/callback), when a new link can be asked for at once.
export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  const t = await getTranslations("auth");
  const { error } = await searchParams;
  const failed = error !== undefined;
  const email = await readPendingEmail();

  return (
    <AuthCard
      title={failed ? t("verify.invalidTitle") : t("verify.title")}
      description={failed ? t("verify.invalidDescription") : t("verify.description")}
      footer={
        <Link href="/sign-in" className={linkClass}>
          {t("verify.backToSignIn")}
        </Link>
      }
    >
      <VerifyEmailNotice
        defaultEmail={email ?? ""}
        initialCooldown={failed ? 0 : RESEND_COOLDOWN_SECONDS}
      />
    </AuthCard>
  );
}
