import { describe, expect, it } from "vitest";
import type { DefaultRegister } from "../schema.js";
import type { HertaSelfModelV1 } from "../self-model/schema.js";
import {
  renderHertaSelf,
  renderSelfModel,
  renderVoiceAsSelfNotes,
} from "./render-self-model.js";

function mk(partial: Partial<HertaSelfModelV1> = {}): HertaSelfModelV1 {
  return {
    version: 1,
    generated_at: "2026-05-11T00:00:00Z",
    provenance: {
      passes: [
        { name: "fact-extract", model: "deepseek-v4-pro" },
        { name: "synthesize", model: "deepseek-v4-pro" },
      ],
    },
    biography: { prose: "我是黑塔本人，#83。", key_facts: [] },
    philosophy: { prose: "我看重效率。", key_facts: [] },
    embodiment: { prose: "我在空间站的工坊。", key_facts: [] },
    relationships: {},
    harness_proprioception: {
      prose: "终端是桌上的线，我亲自打字。",
      key_facts: [],
    },
    anti_patterns: [],
    interaction_register: { prose: "对小事直接。", samples: [] },
    ...partial,
  };
}

describe("renderSelfModel", () => {
  it("renders all four prose slots with rubric headers", () => {
    const out = renderSelfModel(mk());
    expect(out).toContain("【我是谁 — 简史】");
    expect(out).toContain("【我的处世】");
    expect(out).toContain("【我的身体与工坊】");
    expect(out).toContain("【我和这个终端】");
    expect(out).toContain("我是黑塔本人");
    expect(out).toContain("终端是桌上的线");
  });

  it("includes the canon-grounded preamble", () => {
    const out = renderSelfModel(mk());
    expect(out).toMatch(/第一人称/);
    expect(out).toMatch(/canon/);
  });

  it("omits empty slots silently", () => {
    const out = renderSelfModel(
      mk({
        philosophy: { prose: "", key_facts: [] },
        embodiment: { prose: "   ", key_facts: [] },
      }),
    );
    expect(out).toContain("【我是谁 — 简史】");
    expect(out).toContain("【我和这个终端】");
    expect(out).not.toContain("【我的处世】");
    expect(out).not.toContain("【我的身体与工坊】");
  });

  it("returns empty string when every prose slot is empty", () => {
    const out = renderSelfModel(
      mk({
        biography: { prose: "", key_facts: [] },
        philosophy: { prose: "", key_facts: [] },
        embodiment: { prose: "", key_facts: [] },
        harness_proprioception: { prose: "", key_facts: [] },
      }),
    );
    expect(out).toBe("");
  });

  it("does NOT include relationships, anti_patterns, or interaction_register", () => {
    const out = renderSelfModel(
      mk({
        relationships: {
          screwllum: { prose: "螺丝是同事。", evidence: [] },
        },
        anti_patterns: [{ rule: "我不寒暄", evidence: ["x.html"] }],
        interaction_register: {
          prose: "我说话从不客气。",
          samples: [{ scenario: "x", voice_sample: "y" }],
        },
      }),
    );
    expect(out).not.toContain("螺丝");
    expect(out).not.toContain("我不寒暄");
    expect(out).not.toContain("我说话从不客气");
  });

  it("output ends without trailing whitespace", () => {
    const out = renderSelfModel(mk());
    expect(out).toBe(out.trimEnd());
  });
});

const VOICE: DefaultRegister = {
  formsOfAddress: [
    { phrase: "小家伙", evidenceChunkIds: ["c1"] },
    { phrase: "本天才", evidenceChunkIds: ["c2"] },
  ],
  toneInvariants: [{ pattern: "祈使句 + 你 + 听好", evidenceChunkIds: ["c3"] }],
  codeSwitchTriggers: [
    { trigger: "Tch / Erudition", switchTo: "en", evidenceChunkIds: ["c4"] },
  ],
  moodModulators: {
    annoyed: [{ pattern: "啧 / 嘁", evidenceChunkIds: ["c5"] }],
  },
};

describe("renderVoiceAsSelfNotes", () => {
  it("renders forms of address as 「phrase」 list", () => {
    const out = renderVoiceAsSelfNotes(VOICE);
    expect(out).toContain("我用的称呼");
    expect(out).toContain("「小家伙」");
    expect(out).toContain("「本天才」");
  });

  it("renders tone invariants as bullets", () => {
    const out = renderVoiceAsSelfNotes(VOICE);
    expect(out).toContain("我的语气习惯");
    expect(out).toContain("祈使句 + 你 + 听好");
  });

  it("renders code-switch triggers with target language", () => {
    const out = renderVoiceAsSelfNotes(VOICE);
    expect(out).toContain("切到英文");
    expect(out).toContain("Tch / Erudition");
    expect(out).toContain("切到 en");
  });

  it("renders mood modulators per labeled mood", () => {
    const out = renderVoiceAsSelfNotes(VOICE);
    expect(out).toContain("不耐烦时");
    expect(out).toContain("啧 / 嘁");
  });

  it("emits no XML tags", () => {
    const out = renderVoiceAsSelfNotes(VOICE);
    expect(out).not.toContain("<voice-profile");
    expect(out).not.toContain("<pattern>");
  });

  it("returns empty string for an empty register", () => {
    const empty: DefaultRegister = {
      formsOfAddress: [],
      toneInvariants: [],
      codeSwitchTriggers: [],
      moodModulators: {},
    };
    expect(renderVoiceAsSelfNotes(empty)).toBe("");
  });
});

describe("renderHertaSelf — single trunk", () => {
  it("always emits the first-person identity anchor and turn rhythm", () => {
    const out = renderHertaSelf({});
    // No meta-preamble — the block opens directly in Herta's voice. The
    // model reading "我是 The Herta..." inhabits the perspective; reading
    // "下面是我自己" would itself be a directive about how to read.
    expect(out).not.toContain("下面是我自己");
    expect(out).not.toContain("不是别人给我下的指令");
    expect(out.startsWith("我是 The Herta")).toBe(true);
    expect(out).toContain("一根线");
    expect(out).toContain("【对话节奏】");
  });

  it("output is first-person — no 'You are' directives anywhere", () => {
    const out = renderHertaSelf({
      selfModel: mk(),
      voiceRegister: VOICE,
      toolNames: ["read_file", "list_files"],
    });
    expect(out).not.toMatch(/^You are /m);
    expect(out).not.toMatch(/^你是 /m);
    expect(out).not.toContain("Act as");
  });

  it("includes the four self-model prose sections when selfModel is provided", () => {
    const out = renderHertaSelf({ selfModel: mk() });
    expect(out).toContain("【我是谁 — 简史】");
    expect(out).toContain("【我的处世】");
    expect(out).toContain("【我的身体与工坊】");
    expect(out).toContain("【我和这个终端】");
    expect(out).toContain("终端是桌上的线");
  });

  it("renders voice as self-notes (not XML) when voiceRegister is provided", () => {
    const out = renderHertaSelf({ voiceRegister: VOICE });
    expect(out).toContain("【我说话的样子】");
    expect(out).toContain("小家伙");
    expect(out).not.toContain("<voice-profile");
  });

  it("renders the tools coda as a pure inventory when toolNames are provided", () => {
    const out = renderHertaSelf({
      toolNames: ["read_file", "list_files", "unknown_tool"],
    });
    expect(out).toContain("【我手边的工具】");
    expect(out).toContain("read_file");
    expect(out).toContain("list_files");
    expect(out).toContain("unknown_tool"); // unknown name passes through
    // No safety/permission directives in the actor prompt — harness enforces
    // (D4) and tool results carry permission_denied as a structured field.
    expect(out).not.toContain("permission_denied");
    expect(out).not.toContain("harness 管");
  });

  it("omits a section when its input is absent", () => {
    const out = renderHertaSelf({});
    expect(out).not.toContain("【我是谁 — 简史】");
    expect(out).not.toContain("【我说话的样子】");
    expect(out).not.toContain("【我手边的工具】");
    // But the anchor and turn-rhythm always fire.
    expect(out).toContain("【对话节奏】");
  });

  it("output ends without trailing whitespace", () => {
    const out = renderHertaSelf({
      selfModel: mk(),
      voiceRegister: VOICE,
      toolNames: ["read_file"],
    });
    expect(out).toBe(out.trimEnd());
  });

  it("regression: harness_proprioception line surfaces verbatim", () => {
    const out = renderHertaSelf({ selfModel: mk() });
    expect(out).toContain("我亲自打字");
  });
});
