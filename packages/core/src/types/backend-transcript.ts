import type { Message } from "./transcript.js";

/**
 * The backend (差分协处理器) coding model's own machine transcript:
 * provider-shaped role envelopes (`user` / `assistant` / `tool`) that
 * back its tool-call protocol and error recovery. Distinct from
 * TerminalRecord — the backend may *read* TerminalRecord as task
 * evidence, but its working memory of model messages is a
 * BackendTranscript. SPEC v0.2 §4.5.
 *
 * This is a structural alias rather than a new class so v0.2 can wire
 * to the existing TranscriptStore without a parallel data path.
 */
export type BackendTranscript = readonly Message[];
