/**
 * In-memory rolling buffer of the rendered terminal output the user is
 * currently looking at, used to give a model-side process (the
 * microburst narrator) the same observation surface the human user has.
 *
 * The shared-observation rule (PHILOSOPHY §9, §5): Herta should react
 * to what the user is reading, not to internal event payloads. The
 * narrator was previously fed curated per-event trigger messages
 * (e.g. `'The user just saw "Reading..." appear'`), which had to be
 * hand-kept in sync with the renderer's output strings. Threading the
 * actual rendered scrollback removes that duplication: the renderer
 * tees its writes into a scrollback, the narrator reads the tail when
 * it fires, and both reference the same bytes by construction.
 *
 * Implementation notes:
 * - Stores PLAIN text only. ANSI escape sequences (SGR colors, cursor
 *   moves) are stripped on append — the model doesn't care about
 *   color, and the codes would inflate the prompt and confuse the model.
 * - Bounded by `maxStored` to keep memory and prompt budgets predictable.
 *   When the buffer exceeds the cap, the oldest characters are dropped.
 * - `tail(n)` returns the last `n` characters — cheap, no allocation
 *   beyond the slice, suitable for per-burst calls.
 */
export class TerminalScrollback {
  private buf = "";
  private readonly maxStored: number;

  constructor(opts: { maxStored?: number } = {}) {
    // 8 KiB is enough for a screen or two of output even with patch
    // previews. Bumping this is fine; the prompt-time tail() is what
    // bounds token cost, not the storage cap.
    this.maxStored = opts.maxStored ?? 8192;
  }

  /**
   * Append rendered text. ANSI sequences are stripped. Empty input is
   * a no-op. If the cumulative buffer exceeds `maxStored`, the oldest
   * characters are dropped.
   */
  append(text: string): void {
    if (text.length === 0) return;
    this.buf += stripAnsi(text);
    if (this.buf.length > this.maxStored) {
      this.buf = this.buf.slice(this.buf.length - this.maxStored);
    }
  }

  /**
   * Return the last `maxChars` characters of the buffer. If the buffer
   * is shorter than `maxChars`, returns the whole buffer. Pass 0 to
   * get an empty string explicitly.
   */
  tail(maxChars: number): string {
    if (maxChars <= 0) return "";
    if (this.buf.length <= maxChars) return this.buf;
    return this.buf.slice(this.buf.length - maxChars);
  }

  /** Current buffer length in characters. Test helper. */
  size(): number {
    return this.buf.length;
  }

  /** Drop everything. Useful between sessions. */
  clear(): void {
    this.buf = "";
  }
}

// Strip ANSI CSI sequences (SGR colors + cursor moves we might emit
// later) and OSC sequences. Deliberately conservative — only what our
// own renderer emits or could plausibly emit. Don't import a heavy
// ansi-regex dep for this; the patterns we render are small and known.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI escape sequence is intentional
const ANSI_CSI = /\[[0-9;?]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI OSC escape + BEL/ST terminators are intentional
const ANSI_OSC = /\][^]*(?:|\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}
