import { describe, expect, test } from "vitest";
import type { CaseSummary } from "@/api/types";
import { devCases } from "@/api/mocks/devCases";
import { ambiguousCase, bruteForceCase } from "@/api/mocks/fixtures";
import { R_MAX, R_MIN, layoutField } from "./fieldLayout";
import { deriveOverview } from "./overview";

const all: CaseSummary[] = [bruteForceCase.summary, ambiguousCase.summary, ...Object.values(devCases).map((c) => c.summary)];

describe("layoutField", () => {
  const L = layoutField(all, 1200, 420);

  test("is deterministic", () => {
    expect(layoutField(all, 1200, 420)).toEqual(L);
    expect(layoutField([...all].reverse(), 1200, 420).marks.map((m) => m.id)).toEqual(L.marks.map((m) => m.id));
  });

  test("every mark sits inside the plot at its true coordinates", () => {
    for (const m of L.marks) {
      expect(m.x).toBeGreaterThanOrEqual(L.plot.left);
      expect(m.x).toBeLessThanOrEqual(L.plot.right);
      expect(m.y).toBeGreaterThanOrEqual(L.plot.top);
      expect(m.y).toBeLessThanOrEqual(L.plot.bottom);
      expect(m.r).toBeGreaterThanOrEqual(R_MIN);
      expect(m.r).toBeLessThanOrEqual(R_MAX);
    }
  });

  test("y is exactly proportional to the heuristic risk score; marks are never nudged", () => {
    const byRisk = [...L.marks].sort((a, b) => a.c.risk_score.value - b.c.risk_score.value);
    for (let i = 1; i < byRisk.length; i++) expect(byRisk[i]!.y).toBeLessThanOrEqual(byRisk[i - 1]!.y);
    const h = L.plot.bottom - L.plot.top;
    for (const m of L.marks) expect(m.y).toBeCloseTo(L.plot.bottom - (m.c.risk_score.value / 100) * h, 6);
  });

  test("x orders by time and the window span matches first_seen..last_seen", () => {
    const earlier = L.marks.find((m) => m.id === "case_dev_1")!; // 2026-11-17
    const later = L.marks.find((m) => m.id === "case_dev_8")!; // 2026-11-19
    expect(earlier.x).toBeLessThan(later.x);
    for (const m of L.marks) expect(m.x2).toBeGreaterThanOrEqual(m.x1);
  });

  test("larger event counts get larger marks, and large marks are drawn first", () => {
    const big = L.marks.find((m) => m.c.event_count === Math.max(...all.map((c) => c.event_count)))!;
    const small = L.marks.find((m) => m.c.event_count === Math.min(...all.map((c) => c.event_count)))!;
    expect(big.r).toBeGreaterThan(small.r);
    expect(L.marks.indexOf(big)).toBeLessThan(L.marks.indexOf(small));
  });

  test("ticks cover the plot and a single case still yields a valid field", () => {
    expect(L.xTicks.length).toBeGreaterThanOrEqual(2);
    expect(L.yTicks).toHaveLength(5);
    const one = layoutField([bruteForceCase.summary], 900, 360);
    expect(one.marks).toHaveLength(1);
    expect(one.marks[0]!.x).toBeGreaterThan(one.plot.left);
    expect(layoutField([], 900, 360).marks).toHaveLength(0);
  });
});

describe("deriveOverview", () => {
  test("derives only from case summaries", () => {
    const o = deriveOverview(all);
    expect(o.cases).toBe(10);
    expect(o.events).toBe(all.reduce((a, c) => a + c.event_count, 0));
    expect(o.highRisk).toBe(all.filter((c) => c.risk_score.band === "high").length);
    expect(o.open).toBe(all.filter((c) => c.status === "open").length);
    expect(Object.values(o.byVerdict).reduce((a, b) => a + b, 0)).toBe(10);
    expect(deriveOverview([])).toMatchObject({ cases: 0, events: 0, highRisk: 0 });
  });
});
