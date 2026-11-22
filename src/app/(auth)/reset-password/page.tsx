import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { AuthCard } from "@/features/auth/ui/AuthCard";
import {
  ResetLinkExpired,
  ResetPasswordForm,
} from "@/features/auth/ui/ResetPasswordForm";

// The reset link (Better Auth's /api/auth/reset-password/:token) lands here with ?token= when the
// token is valid, or with ?error=INVALID_TOKEN when it has expired or been used.
function usableToken(query: { token?: string | string[]; error?: string | string[] }) {
  const { token, error } = query;
  return typeof token === "string" && token !== "" && error === undefined ? token : null;
}

export async function generateMetadata({
  searchParams,
}: PageProps<"/reset-password">): Promise<Metadata> {
  const t = await getTranslations("auth");
  const token = usableToken(await searchParams);
  // The token is in this page's address: no other site may receive it as a referrer.
  return {
    title: token ? t("reset.title") : t("reset.expiredTitle"),
    referrer: "no-referrer",
  };
}

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const t = await getTranslations("auth");
  const token = usableToken(await searchParams);

  if (!token) {
    return (
      <AuthCard title={t("reset.expiredTitle")}>
        <ResetLinkExpired />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t("reset.title")} description={t("reset.description")}>
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
