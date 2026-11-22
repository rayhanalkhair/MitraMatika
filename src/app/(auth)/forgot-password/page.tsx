import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/features/auth/ui/AuthCard";
import { linkClass } from "@/components/forms/field-styles";
import { ForgotPasswordForm } from "@/features/auth/ui/ForgotPasswordForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("forgot.title") };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations("auth");
  return (
    <AuthCard
      title={t("forgot.title")}
      description={t("forgot.description")}
      footer={
        <Link href="/sign-in" className={linkClass}>
          {t("forgot.backToSignIn")}
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
