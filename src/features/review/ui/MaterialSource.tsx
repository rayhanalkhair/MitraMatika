import { useTranslations } from "next-intl";
import Link from "next/link";
import { BookOpen } from "lucide-react";
import type { ReviewQuestion } from "@/features/review/service/review";

/**
 * The material pages a question was written from: "Sumber: <title>, hal. <n>", a link to that page
 * of the material while it exists, and "Materi sumber telah dihapus" once it was deleted for good
 * (MAT-11). Nothing for a question generated from a topic only.
 */
export function MaterialSource({ sources }: { sources: ReviewQuestion["sources"] }) {
  const t = useTranslations("review.materialSource");
  if (sources.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
      {sources.map((source, index) => {
        const label =
          source.title === null
            ? t("deleted")
            : source.page === null
              ? t("unknownPage", { title: source.title })
              : t("label", { title: source.title, page: String(source.page) });
        return (
          <li key={index} className="flex min-w-0 items-start gap-2">
            <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {source.href ? (
              <Link
                href={source.href}
                className="inline-flex min-h-6 min-w-0 items-center font-medium break-words text-primary underline-offset-4 hover:underline"
              >
                {label}
              </Link>
            ) : (
              <span className="min-w-0 break-words">{label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
