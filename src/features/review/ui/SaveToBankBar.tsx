"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { Archive } from "lucide-react";
import { useState } from "react";
import type { BankActionResult } from "@/features/generation/actions/create-request";
import { useBankApproved } from "./use-bank-approved";

const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60";

export function SaveToBankBar({
  requestId,
  readyCount,
  approvedCount,
  totalCount,
}: {
  requestId: string;
  readyCount: number;
  // Approved including the ones already banked, out of every question shown.
  approvedCount: number;
  totalCount: number;
}) {
  const t = useTranslations("review.bank");
  const bank = useBankApproved(requestId);
  const [outcome, setOutcome] = useState<BankActionResult | null>(null);

  // More approvals (or an undo) make an earlier "n soal tersimpan" or error stale. A drop right
  // after a successful save is that save's own refetch, so the success line stays then.
  const [seenCount, setSeenCount] = useState(readyCount);
  if (seenCount !== readyCount) {
    setSeenCount(readyCount);
    if (!(outcome?.ok && readyCount < seenCount)) setOutcome(null);
  }

  // Local flag so the button changes on the click itself, not on the next render of the mutation.
  const [saving, setSaving] = useState(false);
  const busy = saving || bank.pending;

  const onSave = async () => {
    setOutcome(null);
    setSaving(true);
    try {
      setOutcome(await bank.save());
    } finally {
      setSaving(false);
    }
  };

  return (
    // In normal flow and sticky, never fixed (offset above the mobile bottom nav): it rests under the last card and the list reserves
    // bottom space, so it cannot cover content (B-003).
    <div className="sticky bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom))] z-10 flex min-w-0 flex-col gap-2 rounded-lg border border-primary/30 bg-card p-4 shadow-card md:bottom-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-heading text-sm font-semibold">
          {t("progress", { approved: approvedCount, total: totalCount })}
        </p>
        <p className="text-sm text-muted-foreground">
          {readyCount > 0 ? t("ready", { count: readyCount }) : t("none")}
        </p>
      </div>
      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-success transition-[width] duration-200"
          style={{
            width: `${String(totalCount > 0 ? Math.round((approvedCount / totalCount) * 100) : 0)}%`,
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={readyCount === 0 || busy}
          onClick={() => void onSave()}
          className={buttonClass}
        >
          <Archive aria-hidden="true" className="size-4 shrink-0" />
          {busy ? t("saving") : t("save")}
        </button>
        {outcome?.ok && (
          <Link
            href="/question-bank"
            className="inline-flex min-h-11 min-w-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
          >
            {t("open")}
          </Link>
        )}
      </div>
      {/* Always mounted so the result is announced when it appears. No role: the review page
          already has live regions and the existing role-based tests count them. */}
      <div aria-live="polite" className="text-sm font-medium text-success-foreground">
        {outcome?.ok
          ? outcome.saved > 0
            ? t("saved", { count: outcome.saved })
            : t("nothingNew")
          : ""}
      </div>
      {outcome && !outcome.ok && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {outcome.reason === "signed_out" ? t("errors.signedOut") : t("errors.generic")}
        </p>
      )}
    </div>
  );
}
