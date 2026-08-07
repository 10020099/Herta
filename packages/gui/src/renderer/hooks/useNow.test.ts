import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./useNow.js";

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances by the interval on each tick", () => {
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(first + 30_000);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(first + 60_000);
  });

  it("does not advance before a full interval elapses", () => {
    const { result } = renderHook(() => useNow(30_000));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(result.current).toBe(first);
  });

  it("clears its interval on unmount", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = renderHook(() => useNow(30_000));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
