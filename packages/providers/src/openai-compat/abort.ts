/**
 * Provider-side abort predicate. Wider than `@herta/core`'s `isAbortError`
 * (name only): undici surfaces some interrupts with `code === "ABORT_ERR"`
 * and a different name, and every provider seam below must treat those as
 * the user's interrupt in flight — never re-badge one as a network failure,
 * an SSE error, or an HTTP status. One definition, used by the retry loop,
 * the SSE reader and the deadline helpers.
 */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR")
  );
}

/** A fresh AbortError, named so `isAbortError` (both flavors) classifies it. */
export function abortError(message = "aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}
