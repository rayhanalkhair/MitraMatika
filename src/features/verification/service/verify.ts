import { evaluateClaim, type Claim, type ClaimResult } from "./claims";

export type VerificationStatus =
  "terverifikasi" | "dicek_silang" | "belum_dapat_diverifikasi" | "ketidaksesuaian";

/**
 * Runs the deterministic claim checks. Any failing claim is `ketidaksesuaian`; otherwise any
 * passing claim is `terverifikasi`; with neither, `belum_dapat_diverifikasi`.
 */
export function verifyClaims(claims: Claim[]): {
  status: VerificationStatus;
  results: ClaimResult[];
} {
  const results = claims.map(evaluateClaim);
  if (results.some((r) => r.status === "fail")) {
    return { status: "ketidaksesuaian", results };
  }
  if (results.some((r) => r.status === "pass")) {
    return { status: "terverifikasi", results };
  }
  return { status: "belum_dapat_diverifikasi", results };
}
