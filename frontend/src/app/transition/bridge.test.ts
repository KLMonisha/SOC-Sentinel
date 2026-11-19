import { describe, expect, test } from "vitest";
import { buildBridgeTargets, type Box } from "./bridge";

const boxes: Box[] = [
  { x: 0, y: 0, width: 72, height: 900 },
  { x: 120, y: 90, width: 600, height: 120 },
  { x: 120, y: 260, width: 900, height: 380 },
  { x: 2000, y: 2000, width: 50, height: 50 }, // off-screen: ignored
  { x: 10, y: 10, width: 2, height: 2 }, // too small: ignored
];

describe("buildBridgeTargets", () => {
  const t = buildBridgeTargets(boxes, 1440, 900, 1000);
  test("is deterministic", () => {
    const again = buildBridgeTargets(boxes, 1440, 900, 1000);
    expect(Array.from(again.points)).toEqual(Array.from(t.points));
    expect(Array.from(again.lines)).toEqual(Array.from(t.lines));
  });
  test("every point is on screen (NDC) and flagged as having a target", () => {
    for (let i = 0; i < t.points.length; i += 3) {
      expect(Math.abs(t.points[i]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(t.points[i + 1]!)).toBeLessThanOrEqual(1);
      expect(t.points[i + 2]).toBe(1);
    }
  });
  test("ignores off-screen and tiny boxes; the budget is roughly respected", () => {
    const m = t.points.length / 3;
    expect(m).toBeGreaterThan(700);
    expect(m).toBeLessThan(1200);
    // 3 usable boxes -> 12 outline segments; one orthogonal link (3 segments) joins the two panels
    // (the full-height rail is not linked)
    expect(t.lines.length / 4).toBe(15);
  });
  test("no boxes yields an empty, valid result", () => {
    const e = buildBridgeTargets([], 1440, 900);
    expect(e.points.length).toBe(0);
    expect(e.lines.length).toBe(0);
  });
});
