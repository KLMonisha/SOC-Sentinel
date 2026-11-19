import type { NodeKind, NormGraph } from "./graphModel";

export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drawn silhouette size per kind. Edges are clipped to this; React Flow measures the node at this size. */
export const SHAPE: Record<NodeKind, { w: number; h: number; round: boolean }> = {
  user: { w: 60, h: 60, round: true },
  ip: { w: 54, h: 48, round: true },
  host: { w: 62, h: 44, round: false },
  event: { w: 156, h: 28, round: false },
  finding: { w: 176, h: 38, round: false },
  missing: { w: 56, h: 56, round: true },
};
/** Footprint including the caption under the silhouette. Used only for collision avoidance and framing. */
export const BOX: Record<NodeKind, { w: number; h: number }> = {
  user: { w: 120, h: 100 },
  ip: { w: 132, h: 88 },
  host: { w: 132, h: 84 },
  event: { w: 168, h: 40 },
  finding: { w: 188, h: 52 },
  missing: { w: 136, h: 96 },
};

const TAU = Math.PI * 2;
const START = -Math.PI / 2; // 12 o'clock; clusters run clockwise in chronological order
const R_IN = 150; // non-anchor users / hosts
const R_KEY = 240; // the entity a cluster of events hangs off (usually a source IP)
const R_EVENT = 430;
const ARC = 120; // preferred tangential spacing between event markers
const PAD = 14;
const ITERATIONS = 80;

const polar = (r: number, a: number): Point => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const circularMean = (angles: number[]): number | null => {
  if (angles.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return Math.atan2(sy, sx);
};

type Refs = { user?: string; ip?: string; host?: string };

/**
 * Deterministic, topology-aware radial layout. Pure: same graph in, same positions out (no randomness,
 * no continuous simulation), computed from the FULL graph so nodes never move during replay.
 *
 *  - Anchor: the identity referenced by the most events sits at the centre.
 *  - Events are grouped into clusters by source IP (else host, else user). Each cluster owns an angular
 *    sector sized by its event count; the cluster's entity sits mid-sector and its events fan out
 *    chronologically on an outer arc (extra rings when an arc is too tight).
 *  - Other entities sit on an inner ring at the circular mean of the events that reference them.
 *  - Findings sit outside, at the mean angle of the events they cite.
 *  - Missing telemetry / backend-only items are parked in a reserved sector, apart from observed evidence.
 *  - A fixed-iteration separation pass removes any remaining overlaps.
 *
 * Positions are node CENTRES. Renderer-independent: a 3D view can use them as a starting arrangement.
 */
export function computeLayout(g: NormGraph, orderedEventIds: readonly string[]): Record<string, Point> {
  const order = new Map(orderedEventIds.map((id, i) => [id, i]));
  const refs = new Map<string, Refs>();
  for (const e of g.edges) {
    if (e.state !== "observed" || !e.source.startsWith("event:")) continue;
    const kind = e.target.slice(0, e.target.indexOf(":"));
    if (kind !== "user" && kind !== "ip" && kind !== "host") continue;
    const r = refs.get(e.source) ?? {};
    r[kind] = e.target;
    refs.set(e.source, r);
  }

  const byEvent = (a: { eventId?: string }, b: { eventId?: string }) =>
    (order.get(a.eventId ?? "") ?? 1e9) - (order.get(b.eventId ?? "") ?? 1e9);
  const events = g.nodes.filter((n) => n.kind === "event").sort(byEvent);
  const pos: Record<string, Point> = {};

  // Anchor identity.
  const userCount = new Map<string, number>();
  for (const e of events) {
    const u = refs.get(e.id)?.user;
    if (u) userCount.set(u, (userCount.get(u) ?? 0) + 1);
  }
  const anchor = [...userCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  if (anchor) pos[anchor] = { x: 0, y: 0 };

  // Clusters.
  const clusters = new Map<string, typeof events>();
  for (const e of events) {
    const r = refs.get(e.id) ?? {};
    const key = r.ip ?? r.host ?? r.user ?? "none";
    const list = clusters.get(key) ?? [];
    list.push(e);
    clusters.set(key, list);
  }
  const clusterList = [...clusters.entries()]; // insertion order == chronological by first event

  const isOther = (n: NormGraph["nodes"][number]) =>
    n.kind === "missing" || n.origin === "backend" ||
    (n.kind === "finding" && !(n.citedEventIds ?? []).some((id) => order.has(id)));
  const others = g.nodes.filter(isOther).sort((a, b) => a.id.localeCompare(b.id));
  const gap = others.length > 0 ? 0.16 : 0;
  const avail = TAU * (1 - gap);

  const scale = Math.min(1.8, Math.max(1, Math.sqrt(events.length / 14)));
  const eventAngle = new Map<string, number>();
  let maxR = R_EVENT * scale;
  const totalWeight = clusterList.reduce((s, [, l]) => s + l.length + 1.5, 0) || 1;
  let cursor = START;
  const keyAngle = new Map<string, number>();
  for (const [key, list] of clusterList) {
    let span = (avail * (list.length + 1.5)) / totalWeight;
    const mid = cursor + span / 2;
    cursor += span;
    if (clusterList.length === 1) span = Math.min(span, (240 * Math.PI) / 180);
    keyAngle.set(key, mid);
    if (key !== anchor && key !== "none" && !(key in pos)) pos[key] = polar(R_KEY * scale, mid);

    const usable = span * 0.9;
    const r0 = R_EVENT * scale;
    const cap = Math.max(1, Math.floor((r0 * usable) / ARC));
    list.forEach((e, i) => {
      const ring = Math.floor(i / cap);
      const inRing = Math.min(cap, list.length - ring * cap);
      const j = i % cap;
      const a = mid - usable / 2 + (inRing === 1 ? usable / 2 : (usable * j) / (inRing - 1));
      const r = r0 + ring * 70;
      maxR = Math.max(maxR, r);
      eventAngle.set(e.id, a);
      pos[e.id] = polar(r, a);
    });
  }

  // Remaining entities: inner ring at the circular mean of their events' angles.
  const entityAngles = new Map<string, number[]>();
  for (const e of events) {
    const a = eventAngle.get(e.id);
    if (a === undefined) continue;
    const r = refs.get(e.id) ?? {};
    for (const id of [r.user, r.ip, r.host]) {
      if (id) entityAngles.set(id, [...(entityAngles.get(id) ?? []), a]);
    }
  }
  const entities = g.nodes
    .filter((n) => (n.kind === "user" || n.kind === "ip" || n.kind === "host") && !(n.id in pos) && !isOther(n))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of entities) {
    const a = circularMean(entityAngles.get(n.id) ?? []) ?? START;
    pos[n.id] = polar(n.kind === "ip" ? R_KEY * scale : R_IN, a);
  }

  // Findings sit outside the events they cite.
  const rOut = maxR + 130;
  const findings = g.nodes
    .filter((n) => n.kind === "finding" && !isOther(n))
    .map((n) => ({
      n,
      a: circularMean((n.citedEventIds ?? []).map((id) => eventAngle.get(ids_event(id))).filter((x): x is number => x !== undefined)) ?? START,
    }))
    .sort((p, q) => p.a - q.a || p.n.id.localeCompare(q.n.id));
  findings.forEach(({ n, a }) => (pos[n.id] = polar(rOut, a)));

  // Missing telemetry and backend-only items: reserved sector, visibly apart from observed evidence.
  const gapStart = START + avail;
  others.forEach((n, i) => {
    const a = gapStart + ((TAU - avail) * (i + 0.5)) / others.length;
    pos[n.id] = polar(rOut - 20 + Math.floor(i / 4) * 80, a);
  });

  // Anything not yet placed (defensive): park it on the outer ring in id order.
  g.nodes.filter((n) => !(n.id in pos)).sort((a, b) => a.id.localeCompare(b.id)).forEach((n, i) => {
    pos[n.id] = polar(rOut + 90, START + i * 0.4);
  });

  separate(g, pos, anchor);
  for (const k of Object.keys(pos)) pos[k] = { x: Math.round(pos[k]!.x), y: Math.round(pos[k]!.y) };
  return pos;
}

const ids_event = (eventId: string) => `event:${eventId}`;

/** Fixed-iteration, order-stable overlap removal (not a simulation: it terminates and is repeatable). */
function separate(g: NormGraph, pos: Record<string, Point>, fixed: string | null) {
  const list = g.nodes.map((n) => ({ id: n.id, ...BOX[n.kind] })).sort((a, b) => a.id.localeCompare(b.id));
  for (let it = 0; it < ITERATIONS; it++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const pa = pos[a.id]!;
        const pb = pos[b.id]!;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        const ox = (a.w + b.w) / 2 + PAD - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + PAD - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (dx === 0 && dy === 0) dx = (i + j) % 2 === 0 ? 1 : -1;
        const shareA = a.id === fixed ? 0 : b.id === fixed ? 1 : 0.5;
        const shareB = 1 - shareA;
        if (ox < oy) {
          const s = Math.sign(dx) || 1;
          pa.x -= s * ox * shareA;
          pb.x += s * ox * shareB;
        } else {
          const s = Math.sign(dy) || 1;
          pa.y -= s * oy * shareA;
          pb.y += s * oy * shareB;
        }
      }
    }
    if (!moved) break;
  }
}

/** Bounding box of the given nodes (default: all) including their captions. */
export function layoutBounds(g: NormGraph, layout: Record<string, Point>, only?: ReadonlySet<string>): Bounds | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of g.nodes) {
    if (only && !only.has(n.id)) continue;
    const p = layout[n.id];
    if (!p) continue;
    const b = BOX[n.kind];
    x1 = Math.min(x1, p.x - b.w / 2);
    x2 = Math.max(x2, p.x + b.w / 2);
    y1 = Math.min(y1, p.y - b.h / 2);
    y2 = Math.max(y2, p.y + b.h / 2);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Point where the segment centre->toward leaves the node's silhouette (plus a small gap). */
export function clipToShape(center: Point, toward: Point, kind: NodeKind, gap = 3): Point {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const { w, h, round } = SHAPE[kind];
  const a = w / 2 + gap;
  const b = h / 2 + gap;
  const t = round ? 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2) : Math.min(a / Math.abs(dx || 1e-9), b / Math.abs(dy || 1e-9));
  return { x: center.x + dx * t, y: center.y + dy * t };
}
