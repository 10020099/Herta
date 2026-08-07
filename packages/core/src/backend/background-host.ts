/**
 * Per-brief registry of managed background commands (ADR 0025 slice 4).
 * Lives in core so ToolContext can carry it (tools implement the
 * concrete process entries; the runtime owns the lifecycle). Reset per
 * `runBrief` like the transcript/todo/read-ledger state, and — the
 * load-bearing rule — `stopAll()` runs when the brief ends, so a
 * background dev server can never outlive the dispatch that started it
 * (the shell policy's "no unmanaged backgrounding", kept).
 */
export interface BackgroundProcess {
  readonly id: string;
  readonly argv: readonly string[];
  isRunning(): boolean;
  /** Kill the whole process tree; resolves when the process has closed
   *  (or a bounded grace period elapsed). Idempotent. */
  kill(): Promise<void>;
}

export class BackgroundHost {
  private seq = 0;
  private readonly entries = new Map<string, BackgroundProcess>();

  nextId(): string {
    this.seq += 1;
    return `bg-${this.seq}`;
  }

  register(p: BackgroundProcess): void {
    if (this.entries.has(p.id)) {
      throw new Error(`duplicate background id: ${p.id}`);
    }
    this.entries.set(p.id, p);
  }

  get(id: string): BackgroundProcess | undefined {
    return this.entries.get(id);
  }

  list(): readonly BackgroundProcess[] {
    return [...this.entries.values()];
  }

  /** Kill every still-running process; returns how many were killed. */
  async stopAll(): Promise<number> {
    const running = this.list().filter((p) => p.isRunning());
    await Promise.allSettled(running.map((p) => p.kill()));
    return running.length;
  }
}
