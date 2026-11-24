import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { NotFoundView } from "@/components/shell/NotFoundView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("systemPages.notFound");
  return { title: t("title") };
}

// The 404 of every URL no route matches, inside the root layout only (no app frame): the proxy
// already sent a signed-out visitor to the sign-in page, so whoever sees this has a session cookie.
export default function NotFound() {
  return <NotFoundView framed={false} />;
}
