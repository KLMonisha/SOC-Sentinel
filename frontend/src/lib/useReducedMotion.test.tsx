import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useReducedMotion } from "./useReducedMotion";

const stub = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("useReducedMotion", () => {
  test("reports the user preference", () => {
    stub(true);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
    stub(false);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
  });
  test("is false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useReducedMotion()).result.current).toBe(false);
  });
});
