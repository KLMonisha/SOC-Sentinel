/**
 * Normalized investigation graph. Renderer-agnostic: the 2D React Flow view, the list
 * fallback and a future 3D view all consume this model.
 *
 * Grounding rules:
 *  - Observed edges are DERIVED from stored source events (event -> user/ip/host) and
 *    from finding citations. Each carries a `basis` pointing at the exact field/line.
 *  - Backend `graph` data is used ONLY for non-observed (inferred / missing) items.
 *  - No edges are created from time proximity or between entities directly.
 */
import type { CaseDetail, EvidenceState, Finding, Severity, SourceEvent } from "@/api/types";

export type NodeKind = "user" | "ip" | "host" | "event" | "finding" | "missing";

export interface NormNode {
  /** Stable, namespaced: user:alice, ip:1.2.3.4, event:<backend id>, finding:<id>, missing:<id>, ext:<backend id>. */
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  state: EvidenceState;
  eventId?: string;
  findingId?: string;
  stance?: Finding["stance"];
  severity?: Severity;
  /** Finding nodes: every cited event id, and the subset that does not resolve in this case. */
  citedEventIds?: string[];
  unresolvedEventIds?: string[];
  origin: "derived" | "backend";
}

export interface NormEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  state: EvidenceState;
  /** Source events that establish this edge (empty for missing links). */
  eventIds: string[];
  /** Human-readable justification, shown verbatim in the inspector. */
  basis: string;
  origin: "derived" | "backend";
}

export interface NormGraph {
  nodes: NormNode[];
  edges: NormEdge[];
  /** Non-fatal adapter notes (e.g. backend edge dropped because an endpoint did not resolve). */
  warnings: string[];
}

export const ids = {
  entity: (kind: "user" | "ip" | "host", label: string) => `${kind}:${label}`,
  event: (eventId: string) => `event:${eventId}`,
  finding: (findingId: string) => `finding:${findingId}`,
  missing: (missingId: string) => `missing:${missingId}`,
  external: (backendId: string) => `ext:${backendId}`,
  edge: (source: string, relation: string, target: string) => `${source}|${relation}|${target}`,
};

export const eventIdOfNode = (nodeId: string): string | null =>
  nodeId.startsWith("event:") ? nodeId.slice("event:".length) : null;

/** Chronological, with stable secondary ordering for equal timestamps. */
export function orderEvents(events: readonly SourceEvent[]): SourceEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return (
      a.timestamp.localeCompare(b.timestamp) ||
      a.source_file.localeCompare(b.source_file) ||
      a.line_number - b.line_number ||
      a.event_id.localeCompare(b.event_id)
    );
  });
}

export function buildGraph(c: CaseDetail): NormGraph {
  const nodes = new Map<string, NormNode>();
  const edges = new Map<string, NormEdge>();
  const warnings: string[] = [];
  const known = new Set(c.events.map((e) => e.event_id));

  const addEdge = (e: NormEdge) => {
    if (!edges.has(e.id)) edges.set(e.id, e);
  };

  for (const e of orderEvents(c.events)) {
    const evNode = ids.event(e.event_id);
    nodes.set(evNode, {
      id: evNode, kind: "event", label: e.event_id, sublabel: e.event_type,
      state: "observed", eventId: e.event_id, origin: "derived",
    });
    const where = `${e.source_file}:${e.line_number}`;
    const fields: ["user" | "ip" | "host", string | null, string, string][] = [
      ["user", e.username, "by_user", "username"],
      ["ip", e.source_ip, "from_ip", "source_ip"],
      ["host", e.host, "on_host", "host"],
    ];
    for (const [kind, value, relation, field] of fields) {
      if (!value) continue;
      const entId = ids.entity(kind, value);
      if (!nodes.has(entId)) nodes.set(entId, { id: entId, kind, label: value, state: "observed", origin: "derived" });
      addEdge({
        id: ids.edge(evNode, relation, entId), source: evNode, target: entId, relation, state: "observed",
        eventIds: [e.event_id], basis: `Field ${field} = "${value}" in ${where}`, origin: "derived",
      });
    }
  }

  for (const f of c.findings) {
    const fId = ids.finding(f.finding_id);
    const resolved = f.event_ids.filter((id) => known.has(id));
    nodes.set(fId, {
      id: fId, kind: "finding", label: f.title, sublabel: f.rule_id, state: "observed",
      findingId: f.finding_id, stance: f.stance, severity: f.severity,
      citedEventIds: [...f.event_ids], unresolvedEventIds: f.event_ids.filter((id) => !known.has(id)), origin: "derived",
    });
    for (const id of resolved) {
      const target = ids.event(id);
      addEdge({
        id: ids.edge(fId, "supported_by", target), source: fId, target, relation: "supported_by", state: "observed",
        eventIds: [id], basis: `Finding ${f.rule_id} cites ${id}`, origin: "derived",
      });
    }
  }

  for (const m of c.missing_evidence) {
    const id = ids.missing(m.missing_id);
    nodes.set(id, { id, kind: "missing", label: m.telemetry, sublabel: "missing telemetry", state: "missing", origin: "derived" });
  }

  // Backend graph: only non-observed items; observed ones are already derived from source events.
  const backend = new Map(c.graph.nodes.map((n) => [n.id, n]));
  const resolveBackend = (backendId: string): string | null => {
    const n = backend.get(backendId);
    if (!n) return null;
    if (n.kind === "event") {
      return n.event_id && known.has(n.event_id) ? ids.event(n.event_id) : null;
    }
    const derived = ids.entity(n.kind, n.label);
    if (nodes.has(derived)) return derived;
    return n.state === "observed" ? null : ids.external(n.id);
  };
  for (const n of c.graph.nodes) {
    if (n.state === "observed") continue;
    const id = ids.external(n.id);
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: n.kind === "event" ? "event" : n.kind, label: n.label, state: n.state, origin: "backend" });
    }
  }
  for (const be of c.graph.edges) {
    if (be.state === "observed") continue;
    const source = resolveBackend(be.source);
    const target = resolveBackend(be.target);
    if (!source || !target) {
      warnings.push(`Dropped backend ${be.state} edge ${be.id}: an endpoint did not resolve.`);
      continue;
    }
    const unresolved = be.event_ids.filter((id) => !known.has(id));
    if (unresolved.length) {
      warnings.push(`Dropped backend ${be.state} edge ${be.id}: unresolved event(s) ${unresolved.join(", ")}.`);
      continue;
    }
    addEdge({
      id: ids.edge(source, be.relation, target), source, target, relation: be.relation, state: be.state,
      eventIds: [...be.event_ids],
      basis: `Reported by the backend as ${be.state}; not directly stated in a log field.`, origin: "backend",
    });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], warnings };
}

/** Subgraph for replay: only evidence at or before the replay point is shown. */
export function visibleGraph(g: NormGraph, visibleEventIds: ReadonlySet<string>): NormGraph {
  const eventVisible = (n: NormNode) => n.eventId !== undefined && visibleEventIds.has(n.eventId);
  const connected = new Set<string>(); // entities with at least one visible event
  for (const e of g.edges) {
    if (e.state === "observed" && e.source.startsWith("event:") && visibleEventIds.has(e.eventIds[0] ?? "")) {
      connected.add(e.target);
    }
  }
  const nodes = g.nodes.filter((n) => {
    switch (n.kind) {
      case "event":
        return n.origin === "backend" ? true : eventVisible(n);
      case "finding": {
        const resolved = (n.citedEventIds ?? []).filter((id) => !(n.unresolvedEventIds ?? []).includes(id));
        return resolved.length > 0 && resolved.every((id) => visibleEventIds.has(id));
      }
      case "missing":
        return true;
      default:
        return n.origin === "backend" ? true : connected.has(n.id);
    }
  });
  const ok = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter(
    (e) => ok.has(e.source) && ok.has(e.target) && e.eventIds.every((id) => visibleEventIds.has(id)),
  );
  return { nodes, edges, warnings: g.warnings };
}

export interface Highlight {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export function neighborhood(g: NormGraph, sel: { kind: "node" | "edge"; id: string } | null): Highlight | null {
  if (!sel) return null;
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (sel.kind === "node") {
    if (!g.nodes.some((n) => n.id === sel.id)) return null;
    nodeIds.add(sel.id);
    for (const e of g.edges) {
      if (e.source === sel.id || e.target === sel.id) {
        edgeIds.add(e.id);
        nodeIds.add(e.source);
        nodeIds.add(e.target);
      }
    }
  } else {
    const e = g.edges.find((x) => x.id === sel.id);
    if (!e) return null;
    edgeIds.add(e.id);
    nodeIds.add(e.source);
    nodeIds.add(e.target);
  }
  return { nodeIds, edgeIds };
}
