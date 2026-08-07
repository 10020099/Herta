/**
 * Test-only provider stubs for @herta/app-server session tests.
 *
 * Not exported from the package barrel — internal seam only.
 */
import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
  ProviderAdapter,
  ProviderEvent,
} from "@herta/core";

export interface CompletionScript {
  /** Deltas to yield in order, as `{ type: "text-delta" }` events. */
  readonly deltas: readonly string[];
  /** The stop reason. Defaults to "stop". */
  readonly stopReason?: "stop" | "length" | "error";
}

/**
 * A scripted CompletionProviderAdapter that yields predefined delta
 * sequences in order. Throws with a descriptive message when more calls
 * are made than scripts were provided.
 */
export function stubCompletionProvider(
  scripts: readonly CompletionScript[],
): CompletionProviderAdapter {
  let i = 0;
  return {
    streamCompletion(
      _request: CompletionRequest,
      _signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      const script = scripts[i];
      i += 1;
      if (script === undefined) {
        throw new Error(
          `stubCompletionProvider: no script for call #${i}; provided ${scripts.length}`,
        );
      }
      const deltas = script.deltas;
      const stopReason = script.stopReason ?? "stop";
      return (async function* () {
        for (const delta of deltas) {
          yield { type: "text-delta", text: delta } satisfies CompletionEvent;
        }
        yield { type: "finish", reason: stopReason } satisfies CompletionEvent;
      })();
    },
  };
}

export interface SlowCompletionScript {
  /** Deltas to yield in order, each separated by `delayMs` milliseconds. */
  readonly deltas: readonly string[];
  /** Delay between each delta emission. Defaults to 20 ms. */
  readonly delayMs?: number;
  /** The stop reason. Defaults to "stop". */
  readonly stopReason?: "stop" | "length" | "error";
}

/**
 * A slow CompletionProviderAdapter that yields predefined delta sequences with
 * async delays between each delta. Checks `signal.aborted` before each delta
 * and throws an `AbortError` if the signal has been aborted. This allows tests
 * to interrupt a turn mid-stream.
 *
 * Loops the script indefinitely (repeating the last script) so a slow turn
 * stays in-flight until interrupted.
 */
export function slowStubCompletionProvider(
  script: SlowCompletionScript,
): CompletionProviderAdapter {
  const delayMs = script.delayMs ?? 20;
  const deltas = script.deltas;
  const stopReason = script.stopReason ?? "stop";
  return {
    streamCompletion(
      _request: CompletionRequest,
      signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      return (async function* () {
        for (const delta of deltas) {
          // Abort-aware delay.
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              const e = new DOMException("Aborted", "AbortError");
              reject(e);
              return;
            }
            const timer = setTimeout(resolve, delayMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const e = new DOMException("Aborted", "AbortError");
                reject(e);
              },
              { once: true },
            );
          });
          yield { type: "text-delta", text: delta } satisfies CompletionEvent;
        }
        yield { type: "finish", reason: stopReason } satisfies CompletionEvent;
      })();
    },
  };
}

export interface ChatScript {
  readonly events: readonly ProviderEvent[];
}

/**
 * A scripted ProviderAdapter that yields predefined events in order.
 * Throws on unexpected calls to surface unscripted usage in tests.
 */
export function stubChatProvider(
  scripts: readonly ChatScript[],
): ProviderAdapter {
  let i = 0;
  return {
    streamChat(
      _frame: Parameters<ProviderAdapter["streamChat"]>[0],
      _signal: AbortSignal,
    ): AsyncIterable<ProviderEvent> {
      const script = scripts[i];
      i += 1;
      if (script === undefined) {
        throw new Error(
          `stubChatProvider: no script for call #${i}; provided ${scripts.length}`,
        );
      }
      const events = script.events;
      return (async function* () {
        for (const ev of events) {
          yield ev;
        }
      })();
    },
  };
}
