import { describe, expectTypeOf, it } from "vitest";
import { TranscriptStore } from "../transcript-store.js";
import type { BackendTranscript } from "./backend-transcript.js";
import type { Message } from "./transcript.js";

describe("BackendTranscript", () => {
  it("aligns with TranscriptStore.all() return shape", () => {
    expectTypeOf<BackendTranscript>().toEqualTypeOf<readonly Message[]>();
    expectTypeOf<ReturnType<TranscriptStore["all"]>>().toEqualTypeOf<
      readonly Message[]
    >();
  });

  it("can be populated from a TranscriptStore", () => {
    const store = new TranscriptStore();
    store.appendUser("hi", new Date());
    const transcript: BackendTranscript = store.all();
    expectTypeOf(transcript).toEqualTypeOf<readonly Message[]>();
  });
});
