export interface DreamTriggerOptions {
  /** Idle window — the "user stepped away" detector. */
  idleMs: number;
  /** Cadence floor — minimum wall-clock since the last COMPLETED full pass. */
  cooldownMs: number;
  /** Backoff between attempts, so a no-op pass (which never advances the
   *  persisted cadence anchor) does not re-fire on every poll. */
  minRetryMs: number;
  enabled: boolean;
  now: () => number;
  /** Persisted ms-epoch of the last completed full pass, or null if none.
   *  Read fresh each tick so the cadence floor survives process restarts. */
  lastFullPassAt: () => number | null;
  /** Material gate — enough new sessions OR a long-enough single session.
   *  Evaluated last (it scans transcripts) so the common tick stays O(1). */
  hasEnoughMaterial: () => boolean;
  /** Detached pass. The trigger never awaits its effects on the turn loop. */
  runPass: () => Promise<void>;
}

export class DreamTrigger {
  private lastActivity: number;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private running = false;
  constructor(private readonly opts: DreamTriggerOptions) {
    this.lastActivity = opts.now();
  }
  noteActivity(): void {
    this.lastActivity = this.opts.now();
  }
  /** Call on a coarse timer (e.g. every few minutes) and on session-end. The gates run
   *  cheapest-first; the material scan only runs after idle + cooldown pass, so
   *  the steady-state tick is a handful of timestamp comparisons. */
  async tick(): Promise<void> {
    if (!this.opts.enabled || this.running) return;
    const t = this.opts.now();
    // (1) user still active — never run during or right after a session.
    if (t - this.lastActivity < this.opts.idleMs) return;
    // (2) attempted recently — back off so a no-op pass doesn't spin each poll.
    if (t - this.lastAttempt < this.opts.minRetryMs) return;
    // Record the attempt BEFORE the expensive gates (audit BL9). It used to be
    // set only after gates 3 and 4 passed, so a tick rejected by the 7-day
    // cooldown never counted as an attempt — and gate 2's backoff, which
    // exists precisely so a no-op pass does not spin, never engaged. The
    // result was a full synchronous session listing (statSync + 128KB reads +
    // a sidecar open per session) on the Electron MAIN thread, twelve times an
    // hour, for a pass that could not run.
    this.lastAttempt = t;
    // (3) cadence floor — a full pass completed within the cooldown window.
    const last = this.opts.lastFullPassAt();
    if (last !== null && t - last < this.opts.cooldownMs) return;
    // (4) material gate — enough has accumulated to be worth a pass.
    if (!this.opts.hasEnoughMaterial()) return;
    this.running = true;
    try {
      await this.opts.runPass();
    } finally {
      this.running = false;
    }
  }
}
