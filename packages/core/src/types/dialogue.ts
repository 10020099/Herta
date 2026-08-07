export type DisplayMode = "inline" | "status" | "final" | "permission";

export type VoiceCue =
  | { type: "task_accept"; intensity: 1 | 2 | 3 }
  | { type: "mild_mockery"; intensity: 1 | 2 | 3 }
  | { type: "approval_warning"; intensity: 1 | 2 | 3 }
  | { type: "experiment_success"; intensity: 1 | 2 | 3 }
  | { type: "experiment_failed"; intensity: 1 | 2 | 3 };

export type DialogueEventKind =
  | "task.accepted"
  | "permission.request"
  | "test.failed"
  | "task.finished"
  | "plan.seeded"
  | "research.verdict";

export type Mood = "bored" | "interested" | "annoyed" | "pleased" | "severe";

export type Verbosity = "terse" | "normal" | "dramatic";

export interface DialogueFacts {
  task?: string;
  file?: string;
  command?: string;
  diffSummary?: string;
  evidence?: readonly string[] | string;
  risk?: string;
  residualRisk?: readonly string[];
  nextAction?: string;
  titleCount?: number;
  verdict?: "supported" | "falsified";
}

export interface SemanticPacket {
  event: DialogueEventKind;
  facts: DialogueFacts;
  mood: Mood;
  verbosity: Verbosity;
}

export interface HertaUtterance {
  text: string;
  voiceCue?: VoiceCue;
  displayMode: DisplayMode;
  /**
   * Set when the utterance came from the deterministic template renderer
   * (carries the structured event/mood/verbosity packet). Absent for
   * freeform actor-side outputs like the microburst narrator's per-event
   * reactions, which are authored directly by the LLM.
   */
  semanticPacket?: SemanticPacket;
}
