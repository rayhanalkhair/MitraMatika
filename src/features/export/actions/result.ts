// The wire shape of the export action (a "use server" file may export only async functions).
export type StartExportResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "pending"; jobId: string }
  | { ok: false; reason: "hourlyLimit"; limit: number; resetsAt: string }
  | {
      ok: false;
      reason: "signedOut" | "notFound" | "notApproved" | "stale" | "generic";
    };
