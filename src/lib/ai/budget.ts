const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// Input tokens one image costs (Groq's per-image figure, ADR-0012).
export const TOKENS_PER_IMAGE = 2_048;
// The longest a call waits for the output-per-minute window; longer and the work is deferred.
export const MAX_OUTPUT_WAIT_MS = 70_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface Spend {
  at: number;
  tokens: number;
}

/**
 * In-memory rolling per-minute and per-day token budget per model, from the free-tier limits.
 * `canSpend` checks both windows; `record` books an estimate. `book` does both at once and, for a
 * model with an output-tokens-per-minute limit (the vision model's 1,000), also books the output
 * slot before it waits, so concurrent calls cannot both take the same minute. It is per process: the durable daily quota is `planQuota` in the generation service, which reads the
 * ai_calls table.
 */
export class TokenBudget {
  private readonly spends = new Map<string, Spend[]>();
  private readonly outputs = new Map<string, Spend[]>();

  constructor(
    private readonly limits: { perMinute: number; perDay: number },
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  estimate(text: string, images = 0): number {
    return Math.ceil(text.length / 3.5) + images * TOKENS_PER_IMAGE;
  }

  private used(model: string, windowMs: number): number {
    const cutoff = this.now() - windowMs;
    return (this.spends.get(model) ?? [])
      .filter((s) => s.at > cutoff)
      .reduce((sum, s) => sum + s.tokens, 0);
  }

  canSpend(model: string, tokens: number): boolean {
    return (
      this.used(model, MINUTE_MS) + tokens <= this.limits.perMinute &&
      this.used(model, DAY_MS) + tokens <= this.limits.perDay
    );
  }

  record(model: string, tokens: number): void {
    const list = this.spends.get(model) ?? [];
    list.push({ at: this.now(), tokens });
    this.spends.set(model, list);
  }

  // Starts a budget from spends made earlier (for example rows read back from ai_calls), so
  // a new process sees what earlier processes already used.
  seed(model: string, spends: readonly { at: number; tokens: number }[]): void {
    const list = this.spends.get(model) ?? [];
    list.push(...spends);
    this.spends.set(model, list);
  }

  // How long until `tokens` more output fit under `otpm` in the last minute: 0 when they fit now,
  // Infinity when one request alone is over the limit.
  outputWaitMs(model: string, tokens: number, otpm: number): number {
    if (tokens > otpm) return Infinity;
    const now = this.now();
    const live = (this.outputs.get(model) ?? [])
      .filter((s) => s.at > now - MINUTE_MS)
      .sort((a, b) => a.at - b.at);
    let used = live.reduce((sum, s) => sum + s.tokens, 0);
    for (const spend of live) {
      if (used + tokens <= otpm) break;
      used -= spend.tokens;
      if (used + tokens <= otpm) return spend.at + MINUTE_MS - now;
    }
    return 0;
  }

  /**
   * Books `cost` (and, for a paced model, `output.tokens` of its per-minute output) and resolves
   * true when the call may go ahead. When the output does not fit now but will within 70 s (and
   * before `deadline`), the slot is booked at the time it frees up BEFORE sleeping, so a
   * concurrent call sees it; after the sleep the booking is checked again against what was spent
   * meanwhile and released if it no longer fits. False means defer: nothing stays booked.
   */
  async book(
    model: string,
    cost: number,
    options: { output?: { tokens: number; otpm: number }; deadline?: number } = {},
  ): Promise<boolean> {
    const { output, deadline } = options;
    if (!this.canSpend(model, cost)) return false;
    const waitMs = output ? this.outputWaitMs(model, output.tokens, output.otpm) : 0;
    if (waitMs > MAX_OUTPUT_WAIT_MS) return false;
    const at = this.now() + waitMs;
    if (deadline !== undefined && at > deadline) return false;

    const spend: Spend = { at, tokens: cost };
    this.push(this.spends, model, spend);
    const slot: Spend | undefined = output ? { at, tokens: output.tokens } : undefined;
    if (slot) this.push(this.outputs, model, slot);
    if (waitMs === 0 || !output || !slot) return true;

    await this.sleep(waitMs);
    // Bookings dated later than now were made after this one, knowing about it: only what was
    // spent up to now can push this call out of its slot.
    this.remove(this.spends, model, spend);
    this.remove(this.outputs, model, slot);
    const now = this.now();
    const fits =
      this.spentUpTo(this.spends, model, now, MINUTE_MS) + cost <=
        this.limits.perMinute &&
      this.spentUpTo(this.spends, model, now, DAY_MS) + cost <= this.limits.perDay &&
      this.spentUpTo(this.outputs, model, now, MINUTE_MS) + output.tokens <= output.otpm;
    if (!fits) return false;
    this.push(this.spends, model, { at: now, tokens: cost });
    this.push(this.outputs, model, { at: now, tokens: output.tokens });
    return true;
  }

  private push(map: Map<string, Spend[]>, model: string, spend: Spend): void {
    const list = map.get(model) ?? [];
    list.push(spend);
    map.set(model, list);
  }

  private remove(map: Map<string, Spend[]>, model: string, spend: Spend): void {
    const list = map.get(model) ?? [];
    const index = list.indexOf(spend);
    if (index >= 0) list.splice(index, 1);
  }

  private spentUpTo(
    map: Map<string, Spend[]>,
    model: string,
    now: number,
    windowMs: number,
  ): number {
    return (map.get(model) ?? [])
      .filter((s) => s.at > now - windowMs && s.at <= now)
      .reduce((sum, s) => sum + s.tokens, 0);
  }

  // Output a call produced beyond its booked slot, recorded after the call.
  recordOutput(model: string, tokens: number): void {
    this.push(this.outputs, model, { at: this.now(), tokens });
  }

  // Output spends made elsewhere (another process, read back from ai_calls).
  seedOutput(model: string, spends: readonly { at: number; tokens: number }[]): void {
    const list = this.outputs.get(model) ?? [];
    list.push(...spends);
    this.outputs.set(model, list);
  }
}
