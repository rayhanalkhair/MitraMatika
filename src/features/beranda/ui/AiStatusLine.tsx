import { useTranslations } from "next-intl";
import { CircleCheck, Clock, Loader } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import type { AiStatus } from "../service/ai-status";

const ICON = { ready: CircleCheck, working: Loader, waiting: Clock } as const;
const TONE = { ready: "success", working: "ai", waiting: "warning" } as const;

export function AiStatusLine({ kind, detail }: AiStatus) {
  const t = useTranslations("beranda");
  const Icon = ICON[kind];
  return (
    <StatusPill
      role="status"
      tone={TONE[kind]}
      className="h-auto min-w-0 py-1.5 break-words"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          kind === "working" && "motion-safe:animate-spin",
        )}
      />
      <span className="min-w-0">
        {t(`ai.${kind}`)}
        {detail ? ` · ${detail}` : ""}
      </span>
    </StatusPill>
  );
}
