import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { CaseSummary, Verdict } from "@/api/types";
import { Brackets } from "@/components/ui/Brackets";
import { STATUS_LABEL, VERDICT_LABEL, formatTime } from "@/lib/format";
import { layoutField, type FieldMark } from "./fieldLayout";

/** Verdict is encoded by ring style AND colour, never colour alone. Amber means uncertainty; red only a likely-malicious verdict. */
const STYLE: Record<Verdict, { stroke: string; fill: string; dash?: string; halo: boolean; word: string }> = {
  likely_malicious: { stroke: "#d6595f", fill: "rgba(214,89,95,0.3)", halo: true, word: "solid, haloed" },
  needs_investigation: { stroke: "#e8a15d", fill: "rgba(232,161,93,0.24)", halo: false, word: "solid" },
  insufficient_evidence: { stroke: "#e8a15d", fill: "rgba(232,161,93,0.04)", dash: "3 3", halo: false, word: "dashed" },
  likely_benign: { stroke: "#63ebd8", fill: "rgba(99,235,216,0.1)", halo: false, word: "thin" },
};

const Mark = memo(function Mark({ m, i, active, dim, onHover, onOpen }: {
  m: FieldMark;
  i: number;
  active: boolean;
  dim: boolean;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const s = STYLE[m.c.verdict];
  const closed = m.c.status !== "open";
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(m.id); } };
  return (
    <g
      role="link" tabIndex={0} className="field-mark" style={{ ["--i" as string]: i, opacity: dim ? 0.28 : closed ? 0.62 : 1 }}
      aria-label={`${m.c.title}. ${VERDICT_LABEL[m.c.verdict]}. Risk ${m.c.risk_score.value} of 100. ${m.c.event_count} events. ${STATUS_LABEL[m.c.status]}. Open case.`}
      onMouseEnter={() => onHover(m.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(m.id)} onBlur={() => onHover(null)}
      onClick={() => onOpen(m.id)} onKeyDown={key}
    >
      {m.x2 - m.x1 > 2 * m.r + 10 && ( // the window is drawn only when it is wider than the mark itself
        <>
          <line x1={m.x1} x2={m.x2} y1={m.y} y2={m.y} stroke={s.stroke} strokeOpacity={0.5} strokeWidth={1.5} />
          <line x1={m.x1} x2={m.x1} y1={m.y - 4} y2={m.y + 4} stroke={s.stroke} strokeOpacity={0.5} />
          <line x1={m.x2} x2={m.x2} y1={m.y - 4} y2={m.y + 4} stroke={s.stroke} strokeOpacity={0.5} />
        </>
      )}
      {s.halo && <circle cx={m.x} cy={m.y} r={m.r + 7} fill="none" stroke={s.stroke} strokeOpacity={0.3} />}
      <circle cx={m.x} cy={m.y} r={m.r + 10} fill="transparent" /> {/* generous hit area */}
      <circle cx={m.x} cy={m.y} r={active ? m.r + 2 : m.r} fill={s.fill} stroke={s.stroke} strokeWidth={active ? 2.2 : 1.5} strokeDasharray={s.dash}
        style={{ transition: "r 0.25s var(--ease-out), stroke-width 0.25s" }} />
      {m.c.verdict !== "insufficient_evidence" && m.c.verdict !== "likely_benign" && <circle cx={m.x} cy={m.y} r={2.4} fill={s.stroke} />}
      {active && <circle cx={m.x} cy={m.y} r={m.r + 6} fill="none" stroke="#8ff3e4" strokeOpacity={0.9} strokeWidth={1} />}
    </g>
  );
});

export function FieldLegend() {
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-ink-muted">
      {(Object.keys(STYLE) as Verdict[]).map((v) => (
        <li key={v} className="flex items-center gap-2">
          <svg width="16" height="16" aria-hidden>
            <circle cx="8" cy="8" r="5.5" fill={STYLE[v].fill} stroke={STYLE[v].stroke} strokeWidth="1.4" strokeDasharray={STYLE[v].dash} />
          </svg>
          {VERDICT_LABEL[v]}
        </li>
      ))}
      <li className="text-ink-faint">Size = event count · closed cases are dimmed</li>
    </ul>
  );
}

export function CaseField({ cases, matchIds, hoverId, onHover, loading }: {
  cases: CaseSummary[];
  /** Cases matching the queue filters. Others recede (they are never removed from the field). */
  matchIds?: ReadonlySet<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  loading?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 420 });
  const navigate = useNavigate();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0 && el.clientHeight > 0) setSize({ w: el.clientWidth, h: el.clientHeight }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = useMemo(() => layoutField(cases, size.w, size.h), [cases, size]);
  const hovered = L.marks.find((m) => m.id === hoverId) ?? null;
  const open = (id: string) => navigate(`/app/evidence/${encodeURIComponent(id)}`);
  const topRisk = useMemo(() => L.marks.reduce<FieldMark | null>((b, m) => (!b || m.c.risk_score.value > b.c.risk_score.value ? m : b), null), [L.marks]);

  const tipLeft = hovered ? Math.min(Math.max(hovered.x + hovered.r + 14, 8), size.w - 270) : 0;
  const tipTop = hovered ? Math.min(Math.max(hovered.y - 40, 8), size.h - 150) : 0;

  return (
    <section aria-label="Case field" className="mat-plane brk relative h-full min-h-[300px]" data-bridge>
      <Brackets />
      <div ref={wrap} className="absolute inset-0 overflow-hidden">
        <svg width={size.w} height={size.h} className="block" role="group" aria-label={`Case field: ${cases.length} cases by time window and heuristic risk`}>
          <defs>
            <radialGradient id="cf-glow" cx="70%" cy="20%" r="70%">
              <stop offset="0%" stopColor="#63ebd8" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#63ebd8" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x={0} y={0} width={size.w} height={size.h} fill="url(#cf-glow)" />
          {L.yTicks.map((t) => (
            <g key={t.label}>
              <line x1={L.plot.left} x2={L.plot.right} y1={t.at} y2={t.at} stroke="#63ebd8" strokeOpacity={t.label === "0" ? 0.22 : 0.07} strokeDasharray={t.label === "0" ? undefined : "2 6"} />
              <text x={L.plot.left - 14} y={t.at + 4} textAnchor="end" className="fill-ink-faint font-mono" fontSize={11}>{t.label}</text>
            </g>
          ))}
          {L.xTicks.map((t) => (
            <g key={t.label + t.at}>
              <line x1={t.at} x2={t.at} y1={L.plot.top} y2={L.plot.bottom} stroke="#63ebd8" strokeOpacity={0.05} />
              <text x={t.at} y={L.plot.bottom + 22} textAnchor="middle" className="fill-ink-faint font-mono" fontSize={11}>{t.label}</text>
            </g>
          ))}
          <text x={L.plot.left} y={16} className="fill-ink-faint" fontSize={10.5} letterSpacing="0.18em">HEURISTIC RISK · 0–100 · NOT A PROBABILITY</text>
          <text x={L.plot.right} y={size.h - 8} textAnchor="end" className="fill-ink-faint" fontSize={10.5} letterSpacing="0.18em">TIME WINDOW · UTC</text>

          {!loading && cases.length > 0 && L.marks.map((m, i) => (
            <Mark key={m.id} m={m} i={i} active={hoverId === m.id} dim={(hoverId !== null && hoverId !== m.id) || (matchIds !== undefined && !matchIds.has(m.id))} onHover={onHover} onOpen={open} />
          ))}
          {!loading && topRisk && hoverId === null && (
            <text x={topRisk.x + topRisk.r + 12} y={topRisk.y + 4} className="fill-ink-muted" fontSize={12} style={{ pointerEvents: "none" }}>
              {topRisk.c.title.length > 34 ? `${topRisk.c.title.slice(0, 33)}…` : topRisk.c.title}
            </text>
          )}
        </svg>

        {!loading && cases.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="t-micro text-ink">The field is empty</p>
              <p className="mx-auto mt-2 max-w-sm text-[13px] text-ink-muted">Ingest an authentication or web-server log. Each case it creates appears here by time window and heuristic risk.</p>
            </div>
          </div>
        )}
        {loading && <p role="status" className="absolute bottom-14 left-20 text-[13px] text-ink-muted">Loading cases…</p>}

        {hovered && (
          <div role="tooltip" className="pointer-events-none absolute z-10 w-[255px] mat-raised px-4 py-3" style={{ left: tipLeft, top: tipTop }}>
            <div className="text-[13.5px] font-medium leading-snug text-ink">{hovered.c.title}</div>
            <div className="mt-1 font-mono text-[11px] text-ink-faint">{hovered.id}</div>
            <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-ink-faint">Verdict</dt><dd className="text-ink">{VERDICT_LABEL[hovered.c.verdict]}</dd>
              <dt className="text-ink-faint">Risk</dt><dd className="font-mono text-ink">{hovered.c.risk_score.value} · {hovered.c.risk_score.band}</dd>
              <dt className="text-ink-faint">Events</dt><dd className="font-mono text-ink">{hovered.c.event_count}</dd>
              <dt className="text-ink-faint">Window</dt><dd className="font-mono text-[11px] text-ink-muted">{formatTime(hovered.c.first_seen).slice(5, 16)} → {formatTime(hovered.c.last_seen).slice(11, 16)}</dd>
              <dt className="text-ink-faint">Status</dt><dd className="text-ink">{STATUS_LABEL[hovered.c.status]}</dd>
            </dl>
            <div className="mt-2.5 text-[11px] uppercase tracking-[0.16em] text-verified">Open case ↵</div>
          </div>
        )}
      </div>

    </section>
  );
}
