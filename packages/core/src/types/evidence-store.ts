/**
 * Full machine artifacts that back the bounded excerpts in TerminalRecord.
 * The user can expand evidence on demand (e.g. via /evidence); when they
 * do, the expansion becomes Herta-visible too. The store itself is not
 * fed to Herta — only the rendered handle. SPEC v0.2 §4.4.
 */
export type EvidenceKind =
  | "command-output"
  | "diff"
  | "tool-result"
  | "test-result"
  | "permission-decision"
  | "backend-report";

export interface EvidenceEntry {
  readonly kind: EvidenceKind;
  readonly payload: string;
}

export interface EvidenceHandle {
  readonly uri: string;
}

export interface EvidenceStore {
  put(entry: EvidenceEntry): EvidenceHandle;
  get(handle: EvidenceHandle): EvidenceEntry | undefined;
}

/**
 * In-process EvidenceStore. Slice 1 only needs the type contract and a
 * trivial implementation so later slices can wire it. File-backed
 * persistence under .herta/logs is a later concern.
 */
export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly entries = new Map<string, EvidenceEntry>();
  private counter = 0;

  put(entry: EvidenceEntry): EvidenceHandle {
    this.counter += 1;
    const uri = `evidence://${entry.kind}/${this.counter}`;
    this.entries.set(uri, entry);
    return { uri };
  }

  get(handle: EvidenceHandle): EvidenceEntry | undefined {
    return this.entries.get(handle.uri);
  }
}
