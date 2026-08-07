import { describe, expect, it } from "vitest";
import {
  type EvidenceEntry,
  type EvidenceHandle,
  InMemoryEvidenceStore,
} from "./evidence-store.js";

describe("InMemoryEvidenceStore", () => {
  it("put returns a handle whose uri is evidence://...", () => {
    const store = new InMemoryEvidenceStore();
    const handle = store.put({
      kind: "command-output",
      payload: "ok (12 tests, 8.4s)\n",
    });
    expect(handle.uri.startsWith("evidence://")).toBe(true);
  });

  it("get returns the original entry by handle", () => {
    const store = new InMemoryEvidenceStore();
    const entry: EvidenceEntry = {
      kind: "diff",
      payload: "--- a\n+++ b\n@@\n-x\n+y\n",
    };
    const handle = store.put(entry);
    expect(store.get(handle)).toEqual(entry);
  });

  it("get on an unknown handle returns undefined", () => {
    const store = new InMemoryEvidenceStore();
    const ghost: EvidenceHandle = { uri: "evidence://nope" };
    expect(store.get(ghost)).toBeUndefined();
  });

  it("handles are unique across puts", () => {
    const store = new InMemoryEvidenceStore();
    const h1 = store.put({ kind: "command-output", payload: "a" });
    const h2 = store.put({ kind: "command-output", payload: "b" });
    expect(h1.uri).not.toBe(h2.uri);
  });
});
