import { describe, expect, test } from "vitest";
import { ambiguousCase, bruteForceCase } from "@/api/mocks/fixtures";
import type { CaseDetail, SourceEvent } from "@/api/types";
import { buildGraph, orderEvents, visibleGraph, type NormGraph } from "./model/graphModel";
import { BOX, clipToShape, computeLayout, layoutBounds, type Point } from "./model/layout";

const layoutOf = (c: CaseDetail) => {
  const g = buildGraph(c);
  return { g, pos: computeLayout(g, orderEvents(c.events).map((e) => e.event_id)) };
};

function overlaps(g: NormGraph, pos: Record<string, Point>): string[] {
  const bad: string[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i]!;
      const b = g.nodes[j]!;
      const dx = Math.abs(pos[a.id]!.x - pos[b.id]!.x);
      const dy = Math.abs(pos[a.id]!.y - pos[b.id]!.y);
      if (dx < (BOX[a.kind].w + BOX[b.kind].w) / 2 && dy < (BOX[a.kind].h + BOX[b.kind].h) / 2) bad.push(`${a.id}~${b.id}`);
    }
  }
  return bad;
}

describe.each([["brute force", bruteForceCase], ["ambiguous", ambiguousCase]])("radial layout: %s", (_n, c) => {
  const { g, pos } = layoutOf(c);
  test("positions every node, deterministically, independent of event input order", () => {
    expect(Object.keys(pos).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    expect(layoutOf({ ...c, events: [...c.events].reverse() }).pos).toEqual(pos);
  });
  test("no two node footprints overlap", () => {
    expect(overlaps(g, pos)).toEqual([]);
  });
  test("the constellation stays compact (nothing drifts far away)", () => {
    const b = layoutBounds(g, pos)!;
    expect(b.width).toBeLessThan(2600);
    expect(b.height).toBeLessThan(2600);
  });
  test("replay never moves a node: positions come from the full graph only", () => {
    const ordered = orderEvents(c.events);
    const v = visibleGraph(g, new Set(ordered.slice(0, 2).map((e) => e.event_id)));
    for (const n of v.nodes) expect(pos[n.id]).toBeDefined();
    expect(computeLayout(g, ordered.map((e) => e.event_id))).toEqual(pos);
  });
  test("node identity is stable across rebuilds", () => {
    expect(buildGraph(structuredClone(c)).nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
  });
});

describe("layout scales to a larger investigation", () => {
  const base = bruteForceCase.events[0]!;
  const many: SourceEvent[] = Array.from({ length: 60 }, (_, i) => ({
    ...base,
    event_id: `evt_${String(i).padStart(4, "0")}`,
    timestamp: `2026-11-18T10:${String(i % 60).padStart(2, "0")}:00Z`,
    source_ip: `198.51.100.${(i % 4) + 1}`,
    line_number: i + 1,
  }));
  const c: CaseDetail = { ...bruteForceCase, events: many, findings: [], missing_evidence: [], graph: { nodes: [], edges: [] } };
  test("stays overlap-free and bounded with 60 events and several clusters", () => {
    const { g, pos } = layoutOf(c);
    expect(overlaps(g, pos)).toEqual([]);
    expect(layoutBounds(g, pos)!.width).toBeLessThan(4500);
  });
});

describe("clipToShape", () => {
  test("lines leave the silhouette boundary, never the centre", () => {
    const p = clipToShape({ x: 0, y: 0 }, { x: 500, y: 0 }, "user");
    expect(p.x).toBeGreaterThan(30);
    expect(p.x).toBeLessThan(40);
    expect(clipToShape({ x: 0, y: 0 }, { x: 0, y: 0 }, "user")).toEqual({ x: 0, y: 0 });
  });
});
