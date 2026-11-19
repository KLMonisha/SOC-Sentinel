import type { CaseSummary } from "@/api/types";

/**
 * Case Field geometry. Pure and deterministic.
 *
 * Every mark sits at its TRUE coordinates: x is the case's time window (centre of first_seen..last_seen),
 * y is its heuristic risk score (0..100). Nothing is nudged to avoid overlap, because moving a mark would
 * misreport its time or risk; overlap is handled visually (draw order, hover) instead.
 */
export interface FieldMark {
  id: string;
  /** Centre of the time window, px. */
  x: number;
  y: number;
  r: number;
  /** Window ends, px. */
  x1: number;
  x2: number;
  c: CaseSummary;
}
export interface FieldTick {
  at: number;
  label: string;
}
export interface FieldLayout {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  marks: FieldMark[];
  xTicks: FieldTick[];
  yTicks: FieldTick[];
  domain: { t0: number; t1: number };
}

const PAD = { left: 64, right: 36, top: 30, bottom: 46 };
const STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880];
const MIN_SPAN_MS = 3_600_000;

export const R_MIN = 6;
export const R_MAX = 20;

const two = (n: number) => String(n).padStart(2, "0");
export function tickLabel(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return withDate ? `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${hm}` : hm;
}

export function layoutField(cases: readonly CaseSummary[], width: number, height: number): FieldLayout {
  const plot = { left: PAD.left, top: PAD.top, right: Math.max(width - PAD.right, PAD.left + 10), bottom: Math.max(height - PAD.bottom, PAD.top + 10) };
  const starts = cases.map((c) => Date.parse(c.first_seen)).filter(Number.isFinite);
  const ends = cases.map((c) => Date.parse(c.last_seen)).filter(Number.isFinite);
  let t0 = starts.length ? Math.min(...starts) : Date.UTC(2026, 0, 1);
  let t1 = ends.length ? Math.max(...ends) : t0 + MIN_SPAN_MS;
  if (t1 - t0 < MIN_SPAN_MS) {
    const mid = (t0 + t1) / 2;
    t0 = mid - MIN_SPAN_MS / 2;
    t1 = mid + MIN_SPAN_MS / 2;
  }
  const pad = (t1 - t0) * 0.06;
  t0 -= pad;
  t1 += pad;

  const X = (t: number) => plot.left + ((t - t0) / (t1 - t0)) * (plot.right - plot.left);
  const Y = (v: number) => plot.bottom - (Math.min(100, Math.max(0, v)) / 100) * (plot.bottom - plot.top);

  const counts = cases.map((c) => c.event_count);
  const lo = counts.length ? Math.min(...counts) : 0;
  const hi = counts.length ? Math.max(...counts) : 0;
  const radius = (n: number) => R_MIN + (R_MAX - R_MIN) * (hi === lo ? 0.35 : Math.sqrt((n - lo) / (hi - lo)));

  const marks = cases
    .map<FieldMark>((c) => {
      const a = Date.parse(c.first_seen);
      const b = Date.parse(c.last_seen);
      const mid = (a + b) / 2;
      return { id: c.case_id, x: X(mid), y: Y(c.risk_score.value), r: radius(c.event_count), x1: X(a), x2: X(b), c };
    })
    // Larger marks are drawn first so small ones are never hidden behind them.
    .sort((p, q) => q.r - p.r || p.id.localeCompare(q.id));

  const spanMin = (t1 - t0) / 60_000;
  const target = Math.max(2, Math.floor((plot.right - plot.left) / 110));
  const step = (STEPS_MIN.find((s) => spanMin / s <= target) ?? STEPS_MIN[STEPS_MIN.length - 1]!) * 60_000;
  const crossesDays = new Date(t0).getUTCDate() !== new Date(t1).getUTCDate() || step >= 1_440 * 60_000;
  const xTicks: FieldTick[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) xTicks.push({ at: X(t), label: tickLabel(t, crossesDays) });

  const yTicks: FieldTick[] = [0, 25, 50, 75, 100].map((v) => ({ at: Y(v), label: String(v) }));
  return { width, height, plot, marks, xTicks, yTicks, domain: { t0, t1 } };
}
