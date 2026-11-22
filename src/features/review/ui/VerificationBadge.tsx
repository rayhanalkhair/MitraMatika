import { useTranslations } from "next-intl";
import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  Loader,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import type { DisplayStatus } from "./status-meta";

const ICONS = {
  terverifikasi: CircleCheck,
  dicek_silang: ShieldCheck,
  belum_dapat_diverifikasi: CircleQuestionMark,
  ketidaksesuaian: TriangleAlert,
  checking: Loader,
  waiting: Clock,
} as const;

// Each status has a tone. Verified is success, cross-checked by AI is ai (sky), unverifiable or waiting
// is warning, a mismatch is destructive and a check in progress is neutral with a subtle pulse
// (only without reduced motion).
const TONES = {
  terverifikasi: "success",
  dicek_silang: "ai",
  belum_dapat_diverifikasi: "warning",
  ketidaksesuaian: "destructive",
  checking: "neutral",
  waiting: "warning",
} as const;

// Icon + text, never colour alone (VER-07, WCAG). The border carries a second cue.
export function VerificationBadge({ status }: { status: DisplayStatus }) {
  const t = useTranslations("review");
  const Icon = ICONS[status];
  return (
    <StatusPill
      tone={TONES[status]}
      data-status={status}
      className={status === "checking" ? "motion-safe:animate-pulse" : undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          status === "checking" && "motion-safe:animate-spin",
        )}
      />
      {t(`statuses.${status}`)}
    </StatusPill>
  );
}
