import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import type { StatusTone } from "@/components/ui/status-pill";
import type { MaterialStatus } from "../schema/library";

/** How a material's status reads: a tone and an icon, always next to its words. */
export const STATUS_META: Record<
  MaterialStatus,
  { tone: StatusTone; icon: typeof CheckCircle2 }
> = {
  uploaded: { tone: "neutral", icon: Clock },
  processing: { tone: "neutral", icon: Loader2 },
  needs_review: { tone: "warning", icon: AlertTriangle },
  ready: { tone: "success", icon: CheckCircle2 },
  failed: { tone: "destructive", icon: XCircle },
};

export function statusOf(value: string): MaterialStatus {
  return Object.hasOwn(STATUS_META, value) ? (value as MaterialStatus) : "failed";
}
