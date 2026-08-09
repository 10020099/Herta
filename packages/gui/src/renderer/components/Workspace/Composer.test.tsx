import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { isVoicePlaying, playVoiceClip } from "../../voice/play-voice.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
});

function renderComposer(mock = createMockHertaBridge()) {
  return {
    mock,
    ...renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    ),
  };
}

describe("Composer", () => {
  it("renders the input with placeholder + send button", () => {
    renderComposer();
    expect(screen.getByPlaceholderText("Message Herta…")).toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("disables the send button when input is empty or whitespace", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = screen.getByPlaceholderText("Message Herta…");
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.disabled).toBe(true);
  });

  it("enables the send button when input has non-whitespace content", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    const input = screen.getByPlaceholderText("Message Herta…");
    fireEvent.change(input, { target: { value: "hi" } });
    expect(send.disabled).toBe(false);
  });

  it("clears the input on submit", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(input.value).toBe("");
  });

  /** Activate a session in the given interaction language. */
  function activate(
    mock: ReturnType<typeof createMockHertaBridge>,
    lang: "zh" | "en",
  ): void {
    act(() =>
      mock.emitReset({
        sessionId: `s-${lang}`,
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang,
      }),
    );
  }

  it("translates a typed @brick to the wire token @板砖 on submit in an EN session", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "hand @Brick the parser bug" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    // The record/dispatch gets the wire token — the alias never reaches the model.
    expect(mock.calls.submitText).toEqual(["hand @板砖 the parser bug"]);
  });

  it("does NOT translate an embedded @brick (email / scoped pkg) — no false dispatch", () => {
    // The `@` must START a mention; an embedded @brick must reach dispatch raw.
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "email me at bob@brick.io" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["email me at bob@brick.io"]);
  });

  it("does NOT translate a backticked `@brick` — code spans are quotation (audit 2026-07-16)", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "how do I write `@brick` here?" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["how do I write `@brick` here?"]);
  });

  it("mixed line: converts outside a code span, keeps the span verbatim", () => {
    const { mock } = renderComposer();
    activate(mock, "en");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "ask @brick about `@brick --help` please" },
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual([
      "ask @板砖 about `@brick --help` please",
    ]);
  });

  it("does NOT translate @brick in a zh session (the alias is EN-only)", () => {
    const { mock } = renderComposer();
    activate(mock, "zh");
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@brick x" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual(["@brick x"]);
  });

  it("shows the completion ghost as 'brick' in EN and '板砖' in zh", () => {
    const { mock, container } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    // A boundary '@' with the caret right after it arms the hint (via onSelect,
    // driven deterministically here rather than relying on change-caret).
    const armHint = (): void => {
      fireEvent.change(input, { target: { value: "@" } });
      input.setSelectionRange(1, 1);
      fireEvent.select(input);
    };
    activate(mock, "en");
    armHint();
    expect(container.querySelector(".composer-ghost")?.textContent).toBe(
      "brick",
    );
    activate(mock, "zh");
    armHint();
    expect(container.querySelector(".composer-ghost")?.textContent).toBe(
      "板砖",
    );
  });

  it("clears the draft when the active session changes", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "unsent draft" } });
    expect(input.value).toBe("unsent draft");
    // The active session changes (delete the old session, connect a new one) —
    // the draft must NOT carry over into the new session's composer.
    act(() =>
      mock.emitReset({
        sessionId: "new-session",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
      }),
    );
    expect(input.value).toBe("");
  });

  it("submit calls bridge.submitText + clears input", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toContain("hello");
    expect(input.value).toBe("");
  });

  it("busy disables the textarea and swaps send for an ENABLED stop button", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi" } });
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(input.disabled).toBe(true);
    // The send button is REPLACED by a stop button — the one escape hatch
    // for a hung turn, so it must stay clickable while everything else is
    // disabled.
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
    const stop = screen.getByLabelText(
      "Interrupt the current turn",
    ) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
  });

  it("send and stop are the SAME element morphing (transition prerequisite)", () => {
    // The cross-fade between ↑ and ■ only works if React keeps one DOM node
    // and toggles `.is-stop` — two conditional <button>s would remount and
    // skip the CSS transition (the abrupt swap; user 2026-07-04).
    const { mock } = renderComposer();
    const send = screen.getByLabelText("Send message");
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const stop = screen.getByLabelText("Interrupt the current turn");
    expect(stop).toBe(send);
    expect(stop.classList.contains("is-stop")).toBe(true);
    // Both glyphs stay mounted so they can cross-fade.
    expect(stop.querySelector(".composer-send__glyph--send")).not.toBeNull();
    expect(stop.querySelector(".composer-send__glyph--stop")).not.toBeNull();
  });

  it("clicking stop calls bridge.interrupt", () => {
    const { mock } = renderComposer();
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    fireEvent.click(screen.getByLabelText("Interrupt the current turn"));
    expect(mock.calls.interrupt).toHaveLength(1);
  });

  it("clicking stop cuts in-flight voice on the click (opening skip finishes the turn normally, so the failed-cut never fires)", () => {
    // Minimal Audio stand-in so playVoiceClip can track a live element.
    class FakeAudio {
      currentTime = 0;
      volume = 1;
      play = (): Promise<void> => Promise.resolve();
      pause = (): void => undefined;
      addEventListener = (): void => undefined;
    }
    vi.stubGlobal("Audio", FakeAudio as never);
    const { mock } = renderComposer();
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // The opening voice cue starts a clip mid-turn.
    playVoiceClip("openings", "015-archive-cleanup");
    expect(isVoicePlaying()).toBe(true);
    fireEvent.click(screen.getByLabelText("Interrupt the current turn"));
    expect(isVoicePlaying()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("refocuses the textarea when the turn ends", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(input.disabled).toBe(true); // disabling blurred it
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(document.activeElement).toBe(input);
  });

  it("shrinks after sending (empty) and un-shrinks when typing resumes", () => {
    renderComposer();
    const form = document.querySelector(".composer") as HTMLFormElement;
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi" } });
    act(() => {
      fireEvent.submit(form);
    });
    expect(form.classList.contains("is-shrunk")).toBe(true);
    fireEvent.change(input, { target: { value: "next" } });
    expect(form.classList.contains("is-shrunk")).toBe(false);
  });
});

describe("Composer Enter-to-send (IME-safe)", () => {
  it("Enter submits the trimmed draft", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "你好，黑塔" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mock.calls.submitText).toContain("你好，黑塔");
    expect(input.value).toBe("");
  });

  it("Shift+Enter does NOT submit (newline stays manual)", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(input.value).toBe("line one");
  });

  it("Enter during IME composition does NOT submit (isComposing)", () => {
    // A zh user confirming a pinyin candidate presses Enter with a live
    // composition — that must select the candidate, never send the message.
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "nihao" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(mock.calls.submitText).toHaveLength(0);
    expect(input.value).toBe("nihao");
  });

  it("Enter with keyCode 229 (IME engines post-compositionend) does NOT submit", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "nihao" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mock.calls.submitText).toHaveLength(0);
  });

  it("Enter on an empty draft is a no-op", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mock.calls.submitText).toHaveLength(0);
  });
});

describe("Composer send button ref", () => {
  it("renders a send button that carries the workspace send ref", () => {
    renderComposer();
    const send = screen.getByLabelText("Send message");
    expect(send.tagName).toBe("BUTTON");
  });
});

describe("Composer send tooltip", () => {
  it("shows NO tooltip on the send button (self-evident control; user 2026-06-13)", () => {
    renderComposer();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).not.toHaveAttribute("title");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("Composer @板砖 overlay", () => {
  it("renders a composer-mention chip in the overlay for a full @板砖", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "重构 @板砖" } });
    const chip = document.querySelector(".composer-mention");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("@板砖");
  });

  it("the overlay is aria-hidden (not an accessibility duplicate)", () => {
    renderComposer();
    expect(document.querySelector(".composer-highlight")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("EN session: the overlay chips a typed @brick LITERALLY (what the user actually types)", () => {
    const { mock } = renderComposer();
    act(() =>
      mock.emitReset({
        sessionId: "s-en",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang: "en",
      }),
    );
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hand @Brick this" } });
    const chip = document.querySelector(".composer-mention");
    expect(chip).not.toBeNull();
    // Literal matched text, case preserved — the overlay must stay
    // metric-identical to the textarea (never a substitution).
    expect(chip?.textContent).toBe("@Brick");
    expect(
      document.querySelector(".composer-highlight")?.textContent,
    ).toContain("hand @Brick this");
  });

  it("zh session: a typed @brick does NOT chip (the input alias is EN-only)", () => {
    const { mock } = renderComposer();
    act(() =>
      mock.emitReset({
        sessionId: "s-zh",
        workspaceRoot: "/mock",
        record: [],
        overlay: null,
        backendWorkspace: "/mock",
        backendWorkspaceIsDefault: true,
        lang: "zh",
      }),
    );
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hand @brick this" } });
    expect(document.querySelector(".composer-mention")).toBeNull();
  });
});

describe("Composer @板砖 ghost hint", () => {
  it("shows the ghost when the caret is right after a boundary @", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    const ghost = document.querySelector(".composer-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe("板砖");
  });

  it("shows the ghost for @ at the very start", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
  });

  it("does NOT show the ghost for a non-boundary @ (a@)", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a@" } });
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });

  it("does NOT show the ghost when @ is not right before the caret", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@ hi" } });
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });
});

describe("Composer @板砖 Tab-complete + Esc", () => {
  it("Tab while the hint shows inserts 板砖 and clears the ghost", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("整理 @板砖");
    expect(document.querySelector(".composer-ghost")).toBeNull();
    expect(document.querySelector(".composer-mention")?.textContent).toBe(
      "@板砖",
    );
  });

  it("Tab with no hint active does not insert 板砖", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("hello");
  });

  it("Esc dismisses the ghost without inserting", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector(".composer-ghost")).toBeNull();
    expect(input.value).toBe("hi @");
  });

  it("the ghost is never part of the sent value", () => {
    const { mock } = renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi @" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toContain("hi @");
    expect(mock.calls.submitText).not.toContain("hi @板砖");
  });
});

// Additive coverage carried from the Task 4 code review (onSelect path + a
// whitespace-boundary other than space):
describe("Composer @板砖 hint — extra coverage", () => {
  it("hides the ghost when the caret moves away from the @ (onSelect)", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "整理 @" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
    input.setSelectionRange(2, 2);
    fireEvent.select(input);
    expect(document.querySelector(".composer-ghost")).toBeNull();
  });

  it("shows the ghost after a newline boundary", () => {
    renderComposer();
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "x\n@" } });
    expect(document.querySelector(".composer-ghost")).not.toBeNull();
  });
});

describe("Composer — attachments (ADR 0033)", () => {
  /** A drop event carrying files. jsdom's DataTransfer is not constructible
   *  with files, so hand fireEvent the shape the handler actually reads. */
  function fileDrop(files: Array<{ name: string }>): Record<string, unknown> {
    return {
      dataTransfer: { types: ["Files"], files },
    };
  }

  /** Attaching is session-scoped — the main handler matches the id against the
   *  active session — so the composer no-ops without one. Seed a session the
   *  way the app does, or every assertion below passes vacuously. */
  function renderAttached(mock = createMockHertaBridge()) {
    const r = renderComposer(mock);
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    return r;
  }

  it("opens the picker and forwards the chosen paths", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["/docs/spec.md", "/docs/notes.txt"],
    });
    renderAttached(mock);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add documents"));
    });
    expect(mock.calls.pickAttachments).toBe(1);
    expect(mock.calls.attachFiles).toHaveLength(1);
    expect(mock.calls.attachFiles[0]?.[1]).toEqual([
      "/docs/spec.md",
      "/docs/notes.txt",
    ]);
  });

  it("a cancelled picker attaches nothing", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: null });
    renderAttached(mock);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add documents"));
    });
    expect(mock.calls.attachFiles).toHaveLength(0);
  });

  it("resolves dropped files through the preload rather than File.path", async () => {
    // Electron 43 removed File.path. If this ever regresses to reading the
    // property directly it yields undefined and the drop silently no-ops.
    const mock = createMockHertaBridge();
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }, { name: "b.csv" }]));
    });
    expect(mock.calls.pathForFile).toBe(2);
    expect(mock.calls.attachFiles[0]?.[1]).toEqual(["a.md", "b.csv"]);
  });

  it("highlights on drag enter and clears on leave", () => {
    const { container } = renderComposer();
    const form = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(form, { dataTransfer: { types: ["Files"] } });
    expect(form.className).toContain("is-dragover");
    fireEvent.dragLeave(form, { dataTransfer: { types: ["Files"] } });
    expect(form.className).not.toContain("is-dragover");
  });

  it("ignores a drag that carries no files", () => {
    // Dragging selected text across the composer must not arm the drop UI.
    const { container } = renderComposer();
    const form = container.querySelector(".composer") as HTMLElement;
    fireEvent.dragEnter(form, { dataTransfer: { types: ["text/plain"] } });
    expect(form.className).not.toContain("is-dragover");
  });

  it("surfaces a refusal instead of no-opping silently", async () => {
    // The M6 lesson applied to a new surface: a drop that quietly does nothing
    // reads as a broken drop target.
    const mock = createMockHertaBridge({
      attachFilesResult: { ok: false, message: "a turn is in progress" },
    });
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }]));
    });
    expect(
      screen.getByText(/wait for her, then drop the file/i),
    ).toBeInTheDocument();
  });

  it("names the too-many refusal specifically", async () => {
    const mock = createMockHertaBridge({
      attachFilesResult: { ok: false, message: "too many files at once" },
    });
    const { container } = renderAttached(mock);
    const form = container.querySelector(".composer") as HTMLElement;
    await act(async () => {
      fireEvent.drop(form, fileDrop([{ name: "a.md" }]));
    });
    expect(screen.getByText(/Ten files at a time/i)).toBeInTheDocument();
  });
});
