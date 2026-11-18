import { describe, expect, test } from "vitest";
import { buildRibbon, widthAt } from "./ribbon";

describe("ribbon base surface", () => {
  const r = buildRibbon(160, 24);

  test("is deterministic and finite", () => {
    const again = buildRibbon(160, 24);
    expect(Array.from(again.position.slice(0, 90))).toEqual(Array.from(r.position.slice(0, 90)));
    for (const a of [r.position, r.tangentU, r.tangentV, r.uv]) expect(a.every(Number.isFinite)).toBe(true);
  });

  test("the width never collapses (no degenerate pinch)", () => {
    for (let i = 0; i <= 400; i++) expect(widthAt(i / 400)).toBeGreaterThan(0.1);
  });

  test("the loop closes: the last column coincides with the first with the width flipped (single-sided)", () => {
    const vCount = r.segV + 1;
    const last = r.segU * vCount;
    for (let j = 0; j <= r.segV; j++) {
      const a = last + j; // u = 1, v
      const b = r.segV - j; // u = 0, 1 - v
      for (let c = 0; c < 3; c++) expect(r.position[a * 3 + c]!).toBeCloseTo(r.position[b * 3 + c]!, 2);
    }
  });

  test("tangent vectors are non-degenerate everywhere", () => {
    const n = r.position.length / 3;
    for (let k = 0; k < n; k++) {
      expect(Math.hypot(r.tangentU[k * 3]!, r.tangentU[k * 3 + 1]!, r.tangentU[k * 3 + 2]!)).toBeGreaterThan(0.5);
      expect(Math.hypot(r.tangentV[k * 3]!, r.tangentV[k * 3 + 1]!, r.tangentV[k * 3 + 2]!)).toBeGreaterThan(0.05);
    }
  });

  test("occupies a generous, asymmetric volume (a sculpture, not a ring)", () => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < r.position.length; k += 3) {
      minX = Math.min(minX, r.position[k]!);
      maxX = Math.max(maxX, r.position[k]!);
      minZ = Math.min(minZ, r.position[k + 2]!);
      maxZ = Math.max(maxZ, r.position[k + 2]!);
    }
    expect(maxX - minX).toBeGreaterThan(3.5);
    expect(maxZ - minZ).toBeGreaterThan(1.5);
  });

  test("indices reference valid vertices", () => {
    const n = r.position.length / 3;
    expect(Math.max(...r.index)).toBeLessThan(n);
  });
});
