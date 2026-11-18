import { describe, expect, test } from "vitest";
import { cameraDuration, isComfortablyVisible, shouldMoveCamera } from "./camera";

describe("camera", () => {
  test("reduced motion removes camera animation entirely", () => {
    expect(cameraDuration(true)).toBe(0);
    expect(cameraDuration(false)).toBeGreaterThanOrEqual(250);
    expect(cameraDuration(false)).toBeLessThanOrEqual(500);
  });
  test("visibility accounts for pan and zoom", () => {
    const size = { width: 800, height: 600 };
    const b = { x: 100, y: 100, width: 200, height: 100 };
    expect(isComfortablyVisible(b, { x: 0, y: 0, zoom: 1 }, size)).toBe(true);
    expect(isComfortablyVisible(b, { x: -500, y: 0, zoom: 1 }, size)).toBe(false);
    expect(isComfortablyVisible(b, { x: 0, y: 0, zoom: 4 }, size)).toBe(false);
  });
  test("manual exploration is not hijacked when the target is already in view", () => {
    expect(shouldMoveCamera({ cause: "user", follow: true, force: false, visible: true, zoom: 1 })).toBe(false);
    expect(shouldMoveCamera({ cause: "user", follow: true, force: false, visible: false, zoom: 1 })).toBe(true);
  });
  test("replay-driven selection moves the camera only in follow mode", () => {
    expect(shouldMoveCamera({ cause: "replay", follow: false, force: false, visible: false, zoom: 1 })).toBe(false);
    expect(shouldMoveCamera({ cause: "replay", follow: true, force: false, visible: false, zoom: 1 })).toBe(true);
  });
  test("entering Focus Mode frames the neighbourhood even if it is visible", () => {
    expect(shouldMoveCamera({ cause: "user", follow: false, force: true, visible: true, zoom: 1 })).toBe(true);
  });
});
