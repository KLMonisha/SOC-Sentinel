import { describe, expect, test } from "vitest";
import { bruteForceCase } from "@/api/mocks/fixtures";
import type { CaseDetail, SourceEvent } from "@/api/types";
import { buildGraph, neighborhood, orderEvents, visibleGraph } from "./graphModel";
import { computeLayout } from "./layout";

const clone = <T,>(v: T): T => structuredClone(v);

describe("buildGraph", () => {
  const g = buildGraph(bruteForceCase);

  test("is deterministic: identical input gives identical ids", () => {
    const again = buildGraph(clone(bruteForceCase));
    expect(again.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
    expect(again.edges.map((e) => e.id)).toEqual(g.edges.map((e) => e.id));
  });

  test("event nodes use backend event ids; entities are namespaced", () => {
    expect(g.nodes.some((n) => n.id === "event:evt_0005" && n.eventId === "evt_0005")).toBe(true);
    expect(g.nodes.some((n) => n.id === "user:alice")).toBe(true);
    expect(g.nodes.some((n) => n.id === "ip:203.0.113.45")).toBe(true);
    expect(g.nodes.some((n) => n.id === "host:web-01")).toBe(true);
  });

  test("every edge endpoint exists (no dangling edges)", () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  test("no fabricated edges: every observed edge is backed by a real event field or finding citation", () => {
    const byId = new Map(bruteForceCase.events.map((e) => [e.event_id, e]));
    for (const e of g.edges.filter((x) => x.state === "observed")) {
      const evId = e.eventIds[0]!;
      const ev = byId.get(evId)!;
      expect(ev).toBeDefined();
      if (e.source.startsWith("event:")) {
        const value = e.target.slice(e.target.indexOf(":") + 1);
        expect([ev.username, ev.source_ip, ev.host]).toContain(value);
      } else {
        expect(e.source.startsWith("finding:")).toBe(true);
        const f = bruteForceCase.findings.find((x) => `finding:${x.finding_id}` === e.source)!;
        expect(f.event_ids).toContain(evId);
      }
    }
  });

  test("never links entities directly or by time proximity", () => {
    const entity = (id: string) => /^(user|ip|host):/.test(id);
    for (const e of g.edges) expect(entity(e.source) && entity(e.target) && e.state === "observed").toBe(false);
  });

  test("missing telemetry is a missing node with no edges; backend inferred edge keeps its state and basis", () => {
    const missing = g.nodes.filter((n) => n.state === "missing");
    expect(missing.length).toBeGreaterThan(0);
    const inferred = g.edges.filter((e) => e.state === "inferred");
    expect(inferred).toHaveLength(1);
    expect(inferred[0]!.basis).toMatch(/inferred/i);
    for (const e of g.edges.filter((x) => x.state === "observed")) {
      expect(e.source.startsWith("missing:") || e.target.startsWith("missing:")).toBe(false);
    }
  });

  test("backend observed graph items are ignored (derived from events instead)", () => {
    expect(g.nodes.filter((n) => n.origin === "backend").every((n) => n.state !== "observed")).toBe(true);
  });

  test("citations that do not resolve are recorded and never become edges", () => {
    const c: CaseDetail = clone(bruteForceCase);
    c.findings[0]!.event_ids = [...c.findings[0]!.event_ids, "evt_nope"];
    const gg = buildGraph(c);
    expect(gg.nodes.find((n) => n.findingId === c.findings[0]!.finding_id)!.unresolvedEventIds).toEqual(["evt_nope"]);
    expect(gg.edges.some((e) => e.eventIds.includes("evt_nope") || e.target === "event:evt_nope")).toBe(false);
  });

  test("backend edges with unresolvable endpoints are dropped with a warning", () => {
    const c: CaseDetail = clone(bruteForceCase);
    c.graph.edges.push({ id: "eX", source: "ghost", target: "ip_1", relation: "x", state: "inferred", event_ids: [] });
    expect(buildGraph(c).warnings.some((w) => w.includes("eX"))).toBe(true);
  });
});

describe("orderEvents", () => {
  const mk = (id: string, ts: string, file: string, line: number): SourceEvent => ({
    ...bruteForceCase.events[0]!, event_id: id, timestamp: ts, source_file: file, line_number: line,
  });
  test("chronological; equal timestamps broken by file, line then id, independent of input order", () => {
    const a = mk("b", "2026-11-18T10:00:00Z", "web.json", 1);
    const b = mk("a", "2026-11-18T10:00:00Z", "auth.csv", 9);
    const c = mk("c", "2026-11-18T10:00:00Z", "auth.csv", 2);
    const d = mk("d", "2026-11-18T09:00:00Z", "web.json", 5);
    const want = ["d", "c", "a", "b"];
    expect(orderEvents([a, b, c, d]).map((e) => e.event_id)).toEqual(want);
    expect(orderEvents([d, c, b, a]).map((e) => e.event_id)).toEqual(want);
  });
});

describe("visibleGraph (replay)", () => {
  const g = buildGraph(bruteForceCase);
  const ordered = orderEvents(bruteForceCase.events);

  test("reveals only events at or before the replay point", () => {
    const visible = new Set(ordered.slice(0, 2).map((e) => e.event_id));
    const v = visibleGraph(g, visible);
    const eventNodes = v.nodes.filter((n) => n.kind === "event" && n.origin === "derived").map((n) => n.eventId);
    expect(new Set(eventNodes)).toEqual(visible);
  });

  test("a finding appears only once ALL its cited events are visible", () => {
    const f = bruteForceCase.findings.find((x) => x.finding_id === "f_bf")!;
    const partial = new Set(f.event_ids.slice(0, f.event_ids.length - 1));
    expect(visibleGraph(g, partial).nodes.some((n) => n.findingId === "f_bf")).toBe(false);
    expect(visibleGraph(g, new Set(f.event_ids)).nodes.some((n) => n.findingId === "f_bf")).toBe(true);
  });

  test("entities appear only when a visible event references them; no edges to hidden nodes", () => {
    const v = visibleGraph(g, new Set(["evt_0001"]));
    expect(v.nodes.some((n) => n.id === "host:web-01")).toBe(false);
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
  });

  test("nothing visible at position 0 except missing-telemetry markers", () => {
    const v = visibleGraph(g, new Set());
    expect(v.nodes.every((n) => n.kind === "missing" || n.origin === "backend")).toBe(true);
    expect(v.edges.every((e) => e.state !== "observed")).toBe(true);
  });

  test("full replay equals the full graph", () => {
    const v = visibleGraph(g, new Set(ordered.map((e) => e.event_id)));
    expect(v.nodes.map((n) => n.id).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    expect(v.edges.map((e) => e.id).sort()).toEqual(g.edges.map((e) => e.id).sort());
  });
});

describe("neighborhood", () => {
  const g = buildGraph(bruteForceCase);
  test("node selection highlights incident edges and their endpoints only", () => {
    const h = neighborhood(g, { kind: "node", id: "event:evt_0006" })!;
    expect(h.nodeIds.has("event:evt_0006")).toBe(true);
    expect(h.nodeIds.has("event:evt_0001")).toBe(false);
  });
  test("edge selection highlights its two endpoints", () => {
    const e = g.edges[0]!;
    const h = neighborhood(g, { kind: "edge", id: e.id })!;
    expect([...h.nodeIds].sort()).toEqual([e.source, e.target].sort());
  });
  test("unknown selection yields null", () => {
    expect(neighborhood(g, { kind: "node", id: "nope" })).toBeNull();
  });
});

describe("computeLayout", () => {
  test("assigns a position to every node and is deterministic", () => {
    const g = buildGraph(bruteForceCase);
    const order = orderEvents(bruteForceCase.events).map((e) => e.event_id);
    const a = computeLayout(g, order);
    expect(Object.keys(a).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    expect(computeLayout(g, order)).toEqual(a);
  });
});
