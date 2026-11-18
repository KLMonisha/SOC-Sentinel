import type { NormGraph } from "./graphModel";

export interface Point {
  x: number;
  y: number;
}

const COL = { finding: 0, event: 300, entity: 600, missing: 600 } as const;
const ROW = 72;

/**
 * Deterministic lane layout computed from the FULL graph, so nodes never move during
 * replay. Findings | events (chronological, top to bottom) | entities | missing.
 * Renderer-independent: a 3D view can reuse the lanes as a starting arrangement.
 */
export function computeLayout(g: NormGraph, orderedEventIds: readonly string[]): Record<string, Point> {
  const pos: Record<string, Point> = {};
  const evY = new Map(orderedEventIds.map((id, i) => [id, i * ROW]));
  for (const n of g.nodes) {
    if (n.kind === "event" && n.eventId !== undefined) pos[n.id] = { x: COL.event, y: evY.get(n.eventId) ?? 0 };
  }
  const span = Math.max(orderedEventIds.length - 1, 0) * ROW;

  const findings = g.nodes
    .filter((n) => n.kind === "finding")
    .map((n) => {
      const ys = (n.citedEventIds ?? []).map((id) => evY.get(id)).filter((y): y is number => y !== undefined);
      return { id: n.id, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0 };
    })
    .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  let last = -Infinity;
  for (const f of findings) {
    const y = Math.max(f.y, last + ROW);
    pos[f.id] = { x: COL.finding, y };
    last = y;
  }

  const order = { user: 0, ip: 1, host: 2 } as const;
  const entities = g.nodes
    .filter((n) => n.kind === "user" || n.kind === "ip" || n.kind === "host")
    .sort((a, b) => order[a.kind as keyof typeof order] - order[b.kind as keyof typeof order] || a.label.localeCompare(b.label));
  const top = Math.max(0, (span - (entities.length - 1) * ROW) / 2);
  entities.forEach((n, i) => (pos[n.id] = { x: COL.entity, y: top + i * ROW }));

  const missingStart = top + entities.length * ROW + ROW / 2;
  g.nodes
    .filter((n) => n.kind === "missing")
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach((n, i) => (pos[n.id] = { x: COL.missing, y: missingStart + i * ROW }));

  // Anything else (backend-reported inferred/missing nodes) goes below the entities.
  let extra = missingStart + g.nodes.filter((n) => n.kind === "missing").length * ROW;
  for (const n of g.nodes) {
    if (!pos[n.id]) {
      pos[n.id] = { x: COL.entity, y: extra };
      extra += ROW;
    }
  }
  return pos;
}
