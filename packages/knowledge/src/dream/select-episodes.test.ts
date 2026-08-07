import type { TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { selectEpisodes } from "./select-episodes.js";
import type { Episode } from "./types.js";

const h = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const u = (text: string): TerminalRecordBlock => ({ kind: "user", text });

const ep = (blocks: TerminalRecordBlock[], settled = true): Episode => ({
  sessionId: "s",
  episodeHash: blocks
    .map((b) => (b.kind === "system" ? b.body : b.text))
    .join("|"),
  blocks,
  startIndex: 0,
  endIndex: blocks.length,
  settled,
});

const OPTS = { minHertaBlocks: 2, minEpisodeChars: 10 };

describe("selectEpisodes", () => {
  it("accepts a non-coding episode with enough Herta voice", () => {
    const e = ep([u("聊聊"), h("阮·梅又在搞事。"), h("不过这次我懒得管。")]);
    expect(selectEpisodes([e], OPTS)).toEqual([e]);
  });
  it("rejects an episode with too few Herta blocks", () => {
    expect(selectEpisodes([ep([u("hi"), h("嗯。")])], OPTS)).toEqual([]);
  });
  it("rejects a too-short episode", () => {
    expect(
      selectEpisodes([ep([h("a"), h("b")])], { ...OPTS, minEpisodeChars: 100 }),
    ).toEqual([]);
  });
  it("rejects an unsettled (in-progress) trailing episode", () => {
    expect(
      selectEpisodes([ep([u("x"), h("yy"), h("zz")], false)], OPTS),
    ).toEqual([]);
  });
  it("does NOT require a coding outcome", () => {
    const e = ep([u("闲聊"), h("终端外面又有噪声。"), h("我假装没听见。")]);
    expect(selectEpisodes([e], OPTS)).toContain(e);
  });
  it("does not count live-work chrome bodies toward the char floor", () => {
    const chrome: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: `todo list (3):\n${"[ ] 一个非常长的待办事项描述\n".repeat(20)}`,
      digest: { kind: "todo", total: 3, completed: 0 },
    };
    // Herta text alone is far under the floor; only the chrome body could
    // push it over — and it must not.
    const e = ep([u("x"), h("嗯。"), h("好。"), chrome]);
    expect(selectEpisodes([e], { ...OPTS, minEpisodeChars: 100 })).toEqual([]);
  });
  it("still counts real outcome bodies toward the char floor", () => {
    const marker: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: `完成 · 1 个文件 · ${"证据".repeat(60)}`,
      role: "done-marker",
    };
    const e = ep([u("x"), h("嗯。"), h("好。"), marker]);
    expect(selectEpisodes([e], { ...OPTS, minEpisodeChars: 100 })).toContain(e);
  });
  it("rejects an episode with only herta thought blocks (no speech)", () => {
    const t = (text: string): TerminalRecordBlock => ({
      kind: "herta",
      surface: "thought",
      text,
    });
    const e = ep([
      u("x 这是一段足够长的内容"),
      t("内心独白其一"),
      t("内心独白其二"),
    ]);
    expect(selectEpisodes([e], OPTS)).toEqual([]);
  });
});
