import { describe, expect, it } from "vitest";
import { isPlaceholderOnlySpeech, isUnusableSpeech } from "./speech-shape.js";

describe("isPlaceholderOnlySpeech — the reported shape", () => {
  it("catches the line that reached a user verbatim (2026-08-12)", () => {
    expect(isPlaceholderOnlySpeech("{需要说的话}")).toBe(true);
  });

  it("catches the slot shapes a completion model reaches for", () => {
    for (const s of [
      "{需要说的话}",
      "{{需要说的话}}",
      `$${"{需要说的话}"}`, // ${…} written so it isn't a template placeholder
      "｛需要说的话｝",
      "<需要说的话>",
      "<<your line here>>",
      "[需要说的话]",
      "[[speech]]",
      "［需要说的话］",
      "%SPEECH%",
      "{}", // empty slot is equally not dialogue
      "<>",
    ]) {
      expect(isPlaceholderOnlySpeech(s), s).toBe(true);
    }
  });

  it("ignores whitespace, zero-width padding and trailing punctuation", () => {
    expect(isPlaceholderOnlySpeech("  {需要说的话}  ")).toBe(true);
    expect(isPlaceholderOnlySpeech("{需要说的话}。")).toBe(true);
    expect(isPlaceholderOnlySpeech("​{需要说的话}​")).toBe(true);
  });
});

describe("isPlaceholderOnlySpeech — what it must NOT catch", () => {
  it("leaves real speech about code alone — braces INSIDE a sentence", () => {
    for (const s of [
      "把 `{}` 改成 `[]`，然后再跑一遍。",
      "你这个 {a: 1} 的写法在 TS 里过不了。",
      "第 3 行的 <div> 没闭合。",
      "config 里那个 {{no_banzhuan}} 没被替换掉——这是模板的问题，不是我的。",
    ]) {
      expect(isPlaceholderOnlySpeech(s), s).toBe(false);
    }
  });

  it("leaves the 被烦版 silence reply alone (mood lab 2026-07-17: by design)", () => {
    expect(isPlaceholderOnlySpeech("……")).toBe(false);
    expect(isPlaceholderOnlySpeech("。")).toBe(false);
  });

  it("leaves a parenthetical-only line alone — that is the supervisor's rule", () => {
    expect(isPlaceholderOnlySpeech("（他没听懂。）")).toBe(false);
  });

  it("does not sweep up a long line that merely begins and ends with a brace", () => {
    expect(
      isPlaceholderOnlySpeech("{ 这是一句话 } 后面还有别的 { 内容 }"),
    ).toBe(false);
  });

  it("leaves ordinary Herta speech alone", () => {
    for (const s of [
      "站两天算你交了敲门税，比你前辈沉得住气。",
      "@板砖 把那次运行的日志重新翻出来。",
      "记不得了，你说。",
    ]) {
      expect(isPlaceholderOnlySpeech(s), s).toBe(false);
    }
  });
});

describe("isUnusableSpeech — the commit-boundary predicate", () => {
  it("folds emptiness and slot-only into one test", () => {
    expect(isUnusableSpeech("")).toBe(true);
    expect(isUnusableSpeech("   ")).toBe(true);
    expect(isUnusableSpeech("{需要说的话}")).toBe(true);
    expect(isUnusableSpeech("记不得了，你说。")).toBe(false);
  });
});
