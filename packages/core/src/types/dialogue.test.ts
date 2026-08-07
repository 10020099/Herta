import { describe, expect, it } from "vitest";
import type {
  DialogueEventKind,
  DialogueFacts,
  DisplayMode,
  HertaUtterance,
  Mood,
  SemanticPacket,
  Verbosity,
  VoiceCue,
} from "./dialogue.js";

describe("dialogue type surface", () => {
  it("DisplayMode covers the four documented values", () => {
    const all: DisplayMode[] = ["inline", "status", "final", "permission"];
    expect(all).toHaveLength(4);
  });

  it("Mood covers the five documented values", () => {
    const all: Mood[] = ["bored", "interested", "annoyed", "pleased", "severe"];
    expect(all).toHaveLength(5);
  });

  it("Verbosity covers the three documented values", () => {
    const all: Verbosity[] = ["terse", "normal", "dramatic"];
    expect(all).toHaveLength(3);
  });

  it("DialogueEventKind covers the four MVP kinds", () => {
    const all: DialogueEventKind[] = [
      "task.accepted",
      "permission.request",
      "test.failed",
      "task.finished",
    ];
    expect(all).toHaveLength(4);
  });

  it("VoiceCue is a discriminated union of the five documented types", () => {
    const cues: VoiceCue[] = [
      { type: "task_accept", intensity: 1 },
      { type: "mild_mockery", intensity: 2 },
      { type: "approval_warning", intensity: 3 },
      { type: "experiment_success", intensity: 1 },
      { type: "experiment_failed", intensity: 2 },
    ];
    expect(cues.map((c) => c.type)).toEqual([
      "task_accept",
      "mild_mockery",
      "approval_warning",
      "experiment_success",
      "experiment_failed",
    ]);
  });

  it("DialogueFacts has the documented optional slots", () => {
    const f: DialogueFacts = {
      task: "fix it",
      file: "src/x.ts",
      command: "pnpm test",
      diffSummary: "+1 -1",
      evidence: ["log A"],
      risk: "workspace_write",
      residualRisk: ["network"],
      nextAction: "look at stack",
    };
    expect(f.file).toBe("src/x.ts");
  });

  it("SemanticPacket carries event, facts, mood, verbosity", () => {
    const sp: SemanticPacket = {
      event: "task.accepted",
      facts: { task: "do it" },
      mood: "interested",
      verbosity: "terse",
    };
    expect(sp.mood).toBe("interested");
  });

  it("HertaUtterance has text, displayMode, semanticPacket and optional voiceCue", () => {
    const u: HertaUtterance = {
      text: "好。",
      displayMode: "inline",
      semanticPacket: {
        event: "task.accepted",
        facts: {},
        mood: "interested",
        verbosity: "terse",
      },
    };
    expect(u.voiceCue).toBeUndefined();
    const u2: HertaUtterance = {
      ...u,
      voiceCue: { type: "task_accept", intensity: 1 },
    };
    expect(u2.voiceCue?.type).toBe("task_accept");
  });
});
