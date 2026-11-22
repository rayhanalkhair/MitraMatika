import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { loadAccountSettings, requireAllowedUser } from "@/features/auth";
import { AccountCard, AccountCardUnavailable, LanguageSwitch } from "@/features/settings";
import {
  listTemplates,
  TemplateCard,
  TemplateCardUnavailable,
  type TemplateDb,
  type TemplateView,
} from "@/features/templates";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";

// Under RLS as the signed-in teacher; trashed templates are not listed. A failed read must not take
// the whole page down (account, language and sign-out stay usable): the card says so instead.
async function loadTemplates(userId: string): Promise<TemplateView[] | null> {
  try {
    return await runAsUser(getDb(), userId, (tx) =>
      listTemplates(tx as unknown as TemplateDb, userId),
    );
  } catch (error) {
    logger.error(
      { module: "templates", err: safeErrorSummary(error) },
      "templates: could not list the templates",
    );
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("heading") };
}

export default async function PengaturanPage() {
  const t = await getTranslations("settings");
  const user = await requireAllowedUser();
  const [account, templates] = await Promise.all([
    loadAccountSettings(user.userId),
    loadTemplates(user.userId),
  ]);
  return (
    <PageContainer width="narrow">
      <PageHeader title={t("heading")} />
      <div className="flex flex-col gap-6">
        {account ? <AccountCard account={account} /> : <AccountCardUnavailable />}
        {templates ? <TemplateCard templates={templates} /> : <TemplateCardUnavailable />}
        <LanguageSwitch />
      </div>
    </PageContainer>
  );
}
