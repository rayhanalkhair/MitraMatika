// question_versions is immutable (trigger in drizzle/0002), so verification state lives in
// verification_runs. These helpers are the one place the two storage rules are written down.

// The P1-04 check constraints store the cross-checked status as `dicek_silang_ai`; the
// verification module (and the spec) call it `dicek_silang`. Translate at the storage boundary only.
export function toDbStatus(status: string): string {
  return status === "dicek_silang" ? "dicek_silang_ai" : status;
}

export function fromDbStatus(status: string): string {
  return status === "dicek_silang_ai" ? "dicek_silang" : status;
}

// A regeneration marker is a verification_runs row that records a failed regeneration attempt
// (cross_check = { regeneration: "failed" }); it is history, not a verification run.
export function isRegenerationMarker(crossCheck: unknown): boolean {
  return (
    typeof crossCheck === "object" &&
    crossCheck !== null &&
    "regeneration" in (crossCheck as Record<string, unknown>)
  );
}
