/**
 * High-resolution PNG of the Evidence Constellation, drawn from the same normalised graph and deterministic
 * layout the on-screen view uses (not a screenshot, so it never depends on the current viewport or zoom).
 * The canvas covers the whole graph bounds. The scale is capped by side length and total pixel count so large
 * graphs do not exceed browser canvas limits; below a minimum useful scale the export is refused with a reason.
 *
 * `planGraphExport` is pure and testable; `drawPlan` only needs a 2D context; `exportGraphPng` ties them to a canvas.
 */
import type { EvidenceState } from "@/api/types";
import { type NodeKind, type NormGraph } from "@/features/evidence/model/graphModel";
import { SHAPE, clipToShape, layoutBounds, type Point } from "@/features/evidence/model/layout";
import { MOCK_WATERMARK, sourceLabel, type DataSource } from "./common";

export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;
export const MIN_SCALE = 0.3;
const TARGET_SCALE = 2;
const PAD = 70;
const HEADER = 96;
const FOOTER = 110;
const MIN_W = 1100;

const STROKE: Record<EvidenceState, string> = { observed: "#63ebd8", inferred: "#e8a15d", missing: "#8fa39d" };
const DASH: Record<EvidenceState, number[]> = { observed: [], inferred: [2, 3], missing: [5, 4] };

export interface GraphExportOptions {
  caseId: string;
  source: DataSource;
  exportedAt: Date;
  /** Event id -> ISO timestamp, for event pill captions. */
  timeOf: ReadonlyMap<string, string>;
}

export interface PlanNode { id: string; kind: NodeKind; state: EvidenceState; label: string; caption: string; x: number; y: number; w: number; h: number; stance?: "supporting" | "contradicting"; critical: boolean }
export interface PlanEdge { id: string; x1: number; y1: number; x2: number; y2: number; state: EvidenceState; relation: string }
export interface GraphPlan {
  /** World-space origin offset and canvas size in CSS px at scale 1. */
  width: number;
  height: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  offset: Point;
  nodes: PlanNode[];
  edges: PlanEdge[];
  headline: string;
  meta: string[];
  legend: string[];
  watermark: string | null;
}
export type PlanResult = { ok: true; plan: GraphPlan } | { ok: false; reason: string };

const clock = (iso: string | undefined): string => (iso ? new Date(iso).toISOString().slice(11, 19) : "");
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function planGraphExport(graph: NormGraph, layout: Record<string, Point>, o: GraphExportOptions): PlanResult {
  const b = layoutBounds(graph, layout);
  if (!b || graph.nodes.length === 0) return { ok: false, reason: "There is no evidence graph to export." };
  const contentW = b.width + PAD * 2;
  const width = Math.max(MIN_W, Math.ceil(contentW));
  const height = Math.ceil(b.height + PAD * 2 + HEADER + FOOTER);
  const fit = Math.min(TARGET_SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  if (fit < MIN_SCALE) {
    return { ok: false, reason: `The graph is too large to render as one image within browser limits (${width} × ${height} units). Use the CSV exports for the full data.` };
  }
  // world -> canvas (scale 1): centre the content horizontally when the canvas is wider than the graph
  const offset: Point = { x: PAD - b.x + (width - contentW) / 2, y: HEADER + PAD - b.y };
  const at = (p: Point): Point => ({ x: p.x + offset.x, y: p.y + offset.y });
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind]));

  const nodes: PlanNode[] = graph.nodes.flatMap((n) => {
    const p = layout[n.id];
    if (!p) return [];
    const { w, h } = SHAPE[n.kind];
    const c = at(p);
    const t = n.eventId ? clock(o.timeOf.get(n.eventId)) : "";
    return [{
      id: n.id, kind: n.kind, state: n.state, x: c.x, y: c.y, w, h, stance: n.stance,
      critical: n.severity === "critical" || n.severity === "high",
      label: n.kind === "event" ? `${t} ${n.label}`.trim() : trim(n.label, n.kind === "finding" ? 30 : 22),
      caption: n.kind === "finding" ? `${n.stance === "contradicting" ? "contradicts" : "supports"} · ${n.sublabel ?? ""}` : n.kind === "event" ? "" : n.state !== "observed" ? `${n.sublabel ?? n.kind} · ${n.state}` : (n.sublabel ?? (n.kind === "user" ? "identity" : n.kind)),
    }];
  });

  const edges: PlanEdge[] = graph.edges.flatMap((e) => {
    const a = layout[e.source];
    const t = layout[e.target];
    const ka = kindOf.get(e.source);
    const kb = kindOf.get(e.target);
    if (!a || !t || !ka || !kb) return [];
    const p1 = at(clipToShape(a, t, ka));
    const p2 = at(clipToShape(t, a, kb));
    return [{ id: e.id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, state: e.state, relation: e.relation }];
  });

  const counts = { observed: edges.filter((e) => e.state === "observed").length, inferred: edges.filter((e) => e.state === "inferred").length, missing: edges.filter((e) => e.state === "missing").length };
  return {
    ok: true,
    plan: {
      width, height, scale: fit, pixelWidth: Math.round(width * fit), pixelHeight: Math.round(height * fit), offset, nodes, edges,
      headline: `Evidence constellation · ${o.caseId}`,
      meta: [
        `Exported ${o.exportedAt.toISOString()} · ${sourceLabel(o.source)}`,
        `${nodes.length} nodes · ${edges.length} relationships (${counts.observed} observed, ${counts.inferred} inferred, ${counts.missing} missing) · full investigation, all replay positions`,
      ],
      legend: [
        "Solid mint line: observed (stated by a source log field)",
        "Dotted amber line: inferred (a hypothesis, not stated in any log field)",
        "Dashed grey line / circle: missing telemetry",
        "Lines are associations, not causal flow. Text is data from the case, never instructions.",
      ],
      watermark: o.source === "mock" ? MOCK_WATERMARK : null,
    },
  };
}


/** Draws a plan. Pure drawing: text goes through fillText only (inert), never into markup. */
export function drawPlan(c: CanvasRenderingContext2D, plan: GraphPlan): void {
  const SANS = '"IBM Plex Sans", system-ui, sans-serif';
  const MONO = '"IBM Plex Mono", ui-monospace, monospace';
  c.save();
  c.scale(plan.scale, plan.scale);
  c.fillStyle = "#040a09"; c.fillRect(0, 0, plan.width, plan.height);
  // faint grid
  c.fillStyle = "#0c1814";
  for (let x = 0; x < plan.width; x += 40) c.fillRect(x, HEADER, 1, plan.height - HEADER - FOOTER);
  for (let y = HEADER; y < plan.height - FOOTER; y += 40) c.fillRect(0, y, plan.width, 1);

  // header
  c.fillStyle = "#63ebd8"; c.font = `600 13px ${MONO}`; c.textAlign = "left"; c.textBaseline = "alphabetic";
  c.fillText("S O C   S E N T I N E L", 36, 34);
  c.fillStyle = "#eef3f1"; c.font = `500 22px ${SANS}`; c.fillText(plan.headline, 36, 62);
  c.fillStyle = "#aabdb6"; c.font = `12px ${MONO}`;
  c.fillText(plan.meta[0] ?? "", 36, 82);
  c.fillStyle = "#1c312a"; c.fillRect(0, HEADER - 2, plan.width, 1);

  // edges
  for (const e of plan.edges) {
    c.beginPath(); c.setLineDash(DASH[e.state]); c.lineWidth = 1.4; c.strokeStyle = STROKE[e.state]; c.globalAlpha = e.state === "observed" ? 0.5 : 0.85;
    c.moveTo(e.x1, e.y1); c.lineTo(e.x2, e.y2); c.stroke();
  }
  c.globalAlpha = 1; c.setLineDash([]);

  // nodes
  for (const n of plan.nodes) {
    const stroke = STROKE[n.state];
    c.setLineDash(DASH[n.state]); c.lineWidth = 1.6; c.strokeStyle = stroke; c.fillStyle = "#0e1a16";
    const l = n.x - n.w / 2, t = n.y - n.h / 2;
    if (n.kind === "event") {
      c.beginPath(); c.roundRect(l, t, n.w, n.h, n.h / 2); c.fill(); c.stroke();
      c.setLineDash([]); c.fillStyle = "#63ebd8"; c.beginPath(); c.arc(l + 12, n.y, 3, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#eef3f1"; c.font = `11px ${MONO}`; c.textAlign = "left"; c.fillText(trim(n.label, 24), l + 22, n.y + 4);
    } else if (n.kind === "finding") {
      const accent = n.stance === "contradicting" ? "#9bb0aa" : n.critical ? "#d6595f" : "#e8a15d";
      c.beginPath(); c.rect(l, t, n.w, n.h); c.fill(); c.stroke();
      c.setLineDash([]); c.fillStyle = accent; c.fillRect(l, t, 4, n.h);
      c.font = `11px ${SANS}`; c.textAlign = "left"; c.fillText(n.stance === "contradicting" ? "▼" : "▲", l + 10, n.y + 4);
      c.fillStyle = "#eef3f1"; c.fillText(trim(n.label, 26), l + 26, n.y + 4);
      c.fillStyle = "#76897f"; c.font = `9.5px ${MONO}`; c.fillText(n.caption.toUpperCase(), l + 4, t + n.h + 13);
    } else {
      c.beginPath();
      if (n.kind === "user" || n.kind === "missing") c.arc(n.x, n.y, n.w / 2 - 1.5, 0, Math.PI * 2);
      else if (n.kind === "ip") { const w = n.w, h = n.h; c.moveTo(l + w * 0.25, t + 2); c.lineTo(l + w * 0.75, t + 2); c.lineTo(l + w - 2, n.y); c.lineTo(l + w * 0.75, t + h - 2); c.lineTo(l + w * 0.25, t + h - 2); c.lineTo(l + 2, n.y); c.closePath(); }
      else c.roundRect(l + 2, t + 2, n.w - 4, n.h - 4, 4);
      if (n.kind !== "missing") c.fill();
      c.stroke(); c.setLineDash([]);
      c.fillStyle = "#aabdb6"; c.font = `600 ${n.kind === "missing" ? 18 : 12}px ${MONO}`; c.textAlign = "center";
      c.fillText(n.kind === "missing" ? "?" : n.kind === "user" ? "U" : n.kind === "ip" ? "IP" : "H", n.x, n.y + (n.kind === "missing" ? 6 : 4));
      c.fillStyle = "#eef3f1"; c.font = `11.5px ${n.kind === "ip" ? MONO : SANS}`; c.fillText(n.label, n.x, n.y + n.h / 2 + 18);
      c.fillStyle = "#76897f"; c.font = `9.5px ${MONO}`; c.fillText(n.caption.toUpperCase(), n.x, n.y + n.h / 2 + 32);
    }
  }
  c.setLineDash([]); c.textAlign = "left";

  // legend + metadata footer
  const fy = plan.height - FOOTER;
  c.fillStyle = "#1c312a"; c.fillRect(0, fy, plan.width, 1);
  c.fillStyle = "#63ebd8"; c.font = `600 11px ${MONO}`; c.fillText("LEGEND", 36, fy + 26);
  c.fillStyle = "#aabdb6"; c.font = `11.5px ${SANS}`;
  plan.legend.forEach((l, i) => c.fillText(l, 36, fy + 46 + i * 17));
  c.fillStyle = "#76897f"; c.font = `11px ${MONO}`; c.textAlign = "right";
  c.fillText(plan.meta[1] ?? "", plan.width - 36, fy + 26);
  c.textAlign = "left";

  if (plan.watermark) {
    c.save(); c.globalAlpha = 0.16; c.fillStyle = "#d6595f"; c.textAlign = "center";
    // size the text from its measured width so the whole line stays inside the canvas when rotated
    c.font = `700 100px ${SANS}`;
    const w100 = c.measureText(plan.watermark).width || 1000;
    const size = Math.max(14, Math.min(120, (100 * 0.82 * plan.width) / w100));
    c.font = `700 ${Math.round(size)}px ${SANS}`;
    c.translate(plan.width / 2, plan.height / 2); c.rotate(-0.42); c.fillText(plan.watermark, 0, 0); c.restore();
    c.fillStyle = "#d6595f"; c.font = `700 13px ${MONO}`; c.textAlign = "right"; c.fillText(plan.watermark, plan.width - 36, 34);
  }
  c.restore();
}

export type PngResult = { ok: true; blob: Blob; width: number; height: number; scale: number } | { ok: false; reason: string };

export async function exportGraphPng(graph: NormGraph, layout: Record<string, Point>, o: GraphExportOptions): Promise<PngResult> {
  const planned = planGraphExport(graph, layout, o);
  if (!planned.ok) return planned;
  const { plan } = planned;
  try { await document.fonts?.ready; } catch { /* fonts are cosmetic */ }
  const canvas = document.createElement("canvas");
  canvas.width = plan.pixelWidth;
  canvas.height = plan.pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "This browser could not create a drawing surface large enough for the image." };
  drawPlan(ctx, plan);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob || blob.size === 0) return { ok: false, reason: "The browser could not encode the image (it may be out of memory). Try the CSV exports." };
  return { ok: true, blob, width: plan.pixelWidth, height: plan.pixelHeight, scale: plan.scale };
}

/** Event id -> timestamp map for captions. */
export const timesOf = (events: readonly { event_id: string; timestamp: string }[]): Map<string, string> => new Map(events.map((e) => [e.event_id, e.timestamp]));
