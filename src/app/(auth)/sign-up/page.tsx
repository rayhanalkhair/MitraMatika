import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/features/auth/ui/AuthCard";
import { linkClass } from "@/components/forms/field-styles";
import { GoogleButton } from "@/features/auth/ui/GoogleButton";
import { OrDivider } from "@/features/auth/ui/OrDivider";
import { SignUpForm } from "@/features/auth/ui/SignUpForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("signUp.title") };
}

export default async function SignUpPage() {
  const t = await getTranslations("auth");
  return (
    <AuthCard
      title={t("signUp.title")}
      description={t("signUp.subtitle")}
      footer={
        <p>
          {t("signUp.hasAccount")}{" "}
          <Link href="/sign-in" className={linkClass}>
            {t("signUp.signInLink")}
          </Link>
        </p>
      }
    >
      <GoogleButton intent="signUp" />
      <OrDivider label={t("or")} />
      <SignUpForm />
    </AuthCard>
  );
}
