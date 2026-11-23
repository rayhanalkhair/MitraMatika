import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import Link from "next/link";
import { linkClass } from "@/components/forms/field-styles";
import { LanguageLinks } from "@/features/auth/ui/LanguageLinks";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("privacy");
  return { title: t("title") };
}

const SECTIONS = [
  {
    title: "storedTitle",
    body: ["storedAccount", "storedContent", "storedWhere", "storedTechnical"],
  },
  {
    title: "filesTitle",
    body: ["filesService", "filesMaterials", "filesSolver", "filesExports", "filesTrash"],
  },
  {
    title: "aiTitle",
    body: [
      "aiGroq",
      "aiGroqMaterials",
      "aiSolver",
      "aiLimits",
      "aiGemini",
      "emailService",
    ],
  },
  { title: "studentsTitle", body: ["students"] },
  { title: "deleteTitle", body: ["delete"] },
] as const;

// Public and static: linked from the sign-up form, readable before an account exists.
export default async function PrivacyPage() {
  const t = await getTranslations("privacy");
  return (
    <main className="flex min-h-dvh w-full flex-col items-center gap-6 bg-background px-4 py-8">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary font-heading text-lg font-bold text-primary-foreground"
        >
          M
        </span>
        <span className="font-heading text-xl font-bold tracking-tight">MitraMatika</span>
      </div>
      <article className="flex w-full max-w-2xl flex-col gap-6 rounded-xl border bg-card p-6 shadow-card sm:p-8">
        <div>
          <h1 className="font-heading text-2xl font-bold">{t("title")}</h1>
          <p className="mt-2 text-muted-foreground">{t("intro")}</p>
        </div>
        {SECTIONS.map((section) => (
          <section key={section.title} className="flex flex-col gap-2">
            <h2 className="font-heading text-lg font-bold">{t(section.title)}</h2>
            {section.body.map((key) => (
              <p key={key} className="leading-relaxed">
                {t(key)}
              </p>
            ))}
          </section>
        ))}
        <Link href="/sign-in" className={`${linkClass} self-start`}>
          {t("back")}
        </Link>
      </article>
      <LanguageLinks />
    </main>
  );
}
