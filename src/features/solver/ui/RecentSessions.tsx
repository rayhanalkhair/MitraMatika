import Link from "next/link";
import { useTranslations } from "next-intl";
import { Camera, Keyboard } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { card } from "@/features/materials/ui/styles";
import { VerificationBadge } from "@/features/review/ui/VerificationBadge";
import type { RecentSession } from "../service/sessions";

const STATUS_KEYS = {
  extracting: "reading",
  needs_confirmation: "confirm",
  ready: "solving",
  solved: "solved",
  failed: "failed",
} as const;

/** The teacher's last 20 sessions (decision 10), newest first, each a link to its page. */
export function RecentSessions({
  sessions,
  currentId,
}: {
  sessions: RecentSession[];
  currentId?: string;
}) {
  const t = useTranslations("solve.recent");
  return (
    <section aria-labelledby="recent-sessions" className={card}>
      <h2 id="recent-sessions" className="font-heading text-lg font-bold">
        {t("heading")}
      </h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul aria-labelledby="recent-sessions" className="flex min-w-0 flex-col gap-2">
          {sessions.map((session) => {
            const statusKey =
              session.status in STATUS_KEYS
                ? STATUS_KEYS[session.status as keyof typeof STATUS_KEYS]
                : "failed";
            return (
              <li key={session.id}>
                <Link
                  href={`/solve/${session.id}`}
                  aria-current={session.id === currentId ? "page" : undefined}
                  className="flex min-h-11 min-w-0 flex-col gap-1 rounded-lg border p-3 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:border-primary"
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {session.inputKind === "text" ? (
                      <Keyboard aria-hidden="true" className="size-3.5" />
                    ) : (
                      <Camera aria-hidden="true" className="size-3.5" />
                    )}
                    <span>{session.inputKind === "text" ? t("typed") : t("photo")}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t(`statuses.${statusKey}`)}</span>
                  </span>
                  <MathText
                    text={session.excerptMd || t("untitled")}
                    className="block min-w-0 text-sm break-words"
                  />
                  {session.verificationStatus && (
                    <span>
                      <VerificationBadge status={session.verificationStatus} />
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
