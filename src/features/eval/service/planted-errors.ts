import { evaluateClaim } from "@/features/verification";
import type { Claim, MultipleChoiceQuestion } from "@/features/generation";

// Increments the first run of digits found in a string by `offset`,
// preserving everything else (sign, decimal point, a trailing "%", etc.) —
// this survives every format parseNumber accepts, unlike a naive
// string-append or a list-slice, both of which can silently fail to change
// the claim's truth value.
function corruptNumericString(value: string, offset: number): string {
  const match = /\d+/.exec(value);
  if (match?.index === undefined) return `${value}${String(offset)}`;
  const incremented = String(Number(match[0]) + offset);
  return (
    value.slice(0, match.index) + incremented + value.slice(match.index + match[0].length)
  );
}

// Corrupts one claim in a type-specific way, without touching anything else
// about the question (correctLabel, options, displayed answer stay as the
// model wrote them). This isolates what's being measured: does the
// deterministic verifier catch a claim that's actually wrong, independent of
// the AI's own output quality. Whether the corruption really makes the claim
// false is checked by plantError, not assumed here.
function corruptClaimWithOffset(claim: Claim, offset: number): Claim {
  switch (claim.type) {
    case "numeric_eval":
      return { ...claim, expected: corruptNumericString(claim.expected, offset) };
    case "expression_equivalent":
      return { ...claim, b: `(${claim.b})+${String(offset)}` };
    case "equation_solution":
      return {
        ...claim,
        solutions: claim.solutions.map((s, i) =>
          i === 0 ? corruptNumericString(s, offset) : s,
        ),
      };
    case "choice_matches_answer":
      return { ...claim, answer: corruptNumericString(claim.answer, offset) };
  }
}

// Tried in order until one produces a claim that genuinely fails verification.
// Multiple offsets guard against a corrupted value coincidentally landing on
// another value that still satisfies the claim (e.g. another root of the same
// equation) — see the ruling in .superpowers/sdd/2026-09-26-p017-eval-harness/progress.md.
const CORRUPTION_OFFSETS = [1, 1000, 7];

export function plantError(question: MultipleChoiceQuestion): MultipleChoiceQuestion {
  const claims = question.verification_claims;
  // Target a claim that actually passed: corrupting an "unsupported" claim
  // changes nothing observable, since verifyClaims ignores unsupported claims.
  const targetIndex = claims.findIndex((c) => evaluateClaim(c).status === "pass");
  if (targetIndex === -1) {
    throw new Error("Tidak ada klaim verifikasi yang lolos untuk dirusak.");
  }
  for (const offset of CORRUPTION_OFFSETS) {
    const candidate = corruptClaimWithOffset(claims[targetIndex], offset);
    if (evaluateClaim(candidate).status === "fail") {
      const mutated = [...claims];
      mutated[targetIndex] = candidate;
      return { ...question, verification_claims: mutated };
    }
  }
  throw new Error("Tidak dapat merusak klaim verifikasi hingga benar-benar gagal.");
}
