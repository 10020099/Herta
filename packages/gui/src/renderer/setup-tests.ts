import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// jsdom does not implement matchMedia. Provide a minimal stub so any component
// that calls useReducedMotion (which reads window.matchMedia) does not throw.
// jsdom also does not implement scrollIntoView. Stub it globally so components
// that call endRef.current?.scrollIntoView(...) do not throw.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  // jsdom does not implement ResizeObserver. Minimal stub so hooks that
  // observe content growth (useScrollEdges) construct without throwing.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  // jsdom 26 stopped exposing `localStorage` under Node ≥ 25 (it guards the
  // storage behind a Node version check that this runtime falls outside), so
  // every renderer test that persists a preference threw "setItem is not a
  // function". A plain in-memory Storage keeps them running on any Node.
  if (typeof window.localStorage?.setItem !== "function") {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, String(value));
      },
      removeItem: (key) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: memoryStorage,
    });
  }
}

beforeEach(() => {
  // matchMedia stub is now set up at module load above; nothing extra needed.
});

// Ensure React Testing Library cleanup runs after every test even when
// vitest is configured with globals: false (RTL auto-cleanup relies on
// the global afterEach which is not injected in non-globals mode).
afterEach(() => {
  cleanup();
});
