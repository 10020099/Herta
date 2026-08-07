import type { Message } from "../types/transcript.js";
import type { Evidence } from "./types.js";

export interface BuildEvidenceOptions {
  workspaceRoot: string;
  messages: readonly Message[];
  loreExplicit: boolean;
}

export function buildEvidence(opts: BuildEvidenceOptions): Evidence {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
  return {
    userMessage: lastUser?.role === "user" ? lastUser.text : "",
    workspaceRoot: opts.workspaceRoot,
    loreExplicit: opts.loreExplicit,
  };
}
