/**
 * One definition of "this file is not text".
 *
 * Extracted from `show_excerpt` (ADR 0027) so the attachment ingest (ADR 0033)
 * decides it the same way rather than growing a second, subtly different rule.
 * That matters more than the six lines suggest: the tools reject a binary and
 * the ingest reports one, so if the two disagreed a file could be accepted at
 * the door and then refused by every tool that tried to read it — the user
 * would see an attachment in the record that Herta could never open.
 *
 * A NUL byte in the first 4KB. Crude, and deliberately so: it is the same
 * heuristic git uses, it never false-positives on UTF-8 text (NUL is not a
 * legal UTF-8 continuation byte), and the cost of a false negative is a
 * garbled excerpt rather than anything unsafe.
 */
export const SNIFF_BYTES = 4096;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(SNIFF_BYTES, buf.length)).includes(0);
}
