import { describe, expect, it } from "vitest";
import { stripAnsi, TerminalScrollback } from "./terminal-scrollback.js";

const ESC = String.fromCharCode(0x1b);

describe("stripAnsi", () => {
  it("strips SGR color sequences", () => {
    expect(stripAnsi(`${ESC}[31mhello${ESC}[0m`)).toBe("hello");
    expect(stripAnsi(`${ESC}[1;33mwarn${ESC}[39m`)).toBe("warn");
  });

  it("strips dim+bright sequences (the renderer's most common output)", () => {
    expect(stripAnsi(`${ESC}[2mdim${ESC}[22m`)).toBe("dim");
    expect(stripAnsi(`${ESC}[1mbright${ESC}[22m`)).toBe("bright");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("Reading...\n")).toBe("Reading...\n");
    expect(stripAnsi("« 嗯，在写了 »\n")).toBe("« 嗯，在写了 »\n");
  });

  it("strips a mix of styled and plain text", () => {
    const styled = `  ${ESC}[2mReading...${ESC}[22m\n`;
    expect(stripAnsi(styled)).toBe("  Reading...\n");
  });
});

describe("TerminalScrollback", () => {
  it("append + tail returns recent text", () => {
    const sb = new TerminalScrollback();
    sb.append("hello\n");
    sb.append("world\n");
    expect(sb.tail(100)).toBe("hello\nworld\n");
  });

  it("tail honors the maxChars cap", () => {
    const sb = new TerminalScrollback();
    sb.append("0123456789");
    expect(sb.tail(4)).toBe("6789");
    expect(sb.tail(0)).toBe("");
    expect(sb.tail(-1)).toBe("");
  });

  it("drops the oldest chars when maxStored is exceeded", () => {
    const sb = new TerminalScrollback({ maxStored: 8 });
    sb.append("abcdefgh"); // exactly at cap
    sb.append("ij"); // overflow
    expect(sb.size()).toBe(8);
    expect(sb.tail(100)).toBe("cdefghij");
  });

  it("strips ANSI escapes on append (the model never sees color codes)", () => {
    const sb = new TerminalScrollback();
    sb.append(`${ESC}[2mReading...${ESC}[22m\n`);
    expect(sb.tail(100)).toBe("Reading...\n");
  });

  it("append('') is a no-op", () => {
    const sb = new TerminalScrollback();
    sb.append("");
    expect(sb.size()).toBe(0);
    expect(sb.tail(10)).toBe("");
  });

  it("clear() drops everything", () => {
    const sb = new TerminalScrollback();
    sb.append("hello");
    sb.clear();
    expect(sb.size()).toBe(0);
    expect(sb.tail(100)).toBe("");
  });

  it("preserves interleaved styled + plain output in arrival order", () => {
    // Simulates a turn rendering: workflow label (dim) then narrator
    // burst (bright) then another label.
    const sb = new TerminalScrollback();
    sb.append(`  ${ESC}[2mReading...${ESC}[22m\n`);
    sb.append(`${ESC}[1m« 啧，又翻文件 »${ESC}[22m\n`);
    sb.append(`  ${ESC}[2mPlanning...${ESC}[22m\n`);
    expect(sb.tail(200)).toBe(
      "  Reading...\n« 啧，又翻文件 »\n  Planning...\n",
    );
  });
});
