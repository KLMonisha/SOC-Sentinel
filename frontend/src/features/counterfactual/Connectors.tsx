import { useLayoutEffect, useState, type RefObject } from "react";

interface Pt { x: number; y: number }
interface Geo { w: number; h: number; a: Pt; node: Pt; nodeRight: Pt; b: Pt }

const curve = (p: Pt, q: Pt) => {
  const dx = (q.x - p.x) * 0.5;
  return `M ${p.x} ${p.y} C ${p.x + dx} ${p.y}, ${q.x - dx} ${q.y}, ${q.x} ${q.y}`;
};

/**
 * Draws the branch: stored case -> the excluded event -> recomputed branch. Purely illustrative geometry over
 * the three real elements; it carries no data. Hidden when the layout is stacked (narrow screens).
 */
export function Connectors({ stage, original, spineNode, recomputed, state }: {
  stage: RefObject<HTMLElement | null>;
  original: RefObject<HTMLElement | null>;
  spineNode: string | null;
  recomputed: RefObject<HTMLElement | null>;
  state: "idle" | "running" | "done";
}) {
  const [geo, setGeo] = useState<Geo | null>(null);

  useLayoutEffect(() => {
    const st = stage.current;
    if (!st) return;
    const measure = () => {
      const s = st.getBoundingClientRect();
      const o = original.current?.getBoundingClientRect();
      const r = recomputed.current?.getBoundingClientRect();
      const n = spineNode ? st.querySelector<HTMLElement>(`[data-event-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(spineNode) : spineNode}"]`)?.getBoundingClientRect() : null;
      if (!o || !r || !n || s.width < 1100) { setGeo(null); return; }
      setGeo({
        w: s.width, h: s.height,
        a: { x: o.right - s.left, y: Math.min(o.top - s.top + 90, o.bottom - s.top - 20) },
        node: { x: n.left - s.left + 9, y: n.top - s.top + n.height / 2 },
        nodeRight: { x: n.right - s.left, y: n.top - s.top + n.height / 2 },
        b: { x: r.left - s.left, y: Math.min(r.top - s.top + 90, r.bottom - s.top - 20) },
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(st);
    [original.current, recomputed.current].forEach((el) => el && ro.observe(el));
    const t = window.setTimeout(measure, 560); // after the lifted event finishes its slide
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [stage, original, recomputed, spineNode, state]);

  if (!geo) return null;
  const right = geo.nodeRight;
  return (
    <svg aria-hidden width={geo.w} height={geo.h} className="pointer-events-none absolute inset-0 hidden xl:block">
      <path d={curve(geo.a, geo.node)} fill="none" stroke="#63ebd8" strokeOpacity={0.55} strokeWidth={1.25} />
      <circle cx={geo.node.x} cy={geo.node.y} r={4} fill="#63ebd8" />
      <path
        key={state} d={curve(right, geo.b)} fill="none" pathLength={state === "done" ? 1 : undefined}
        stroke={state === "idle" ? "#2f4f45" : "#63ebd8"} strokeOpacity={state === "idle" ? 0.7 : 0.8} strokeWidth={1.25}
        strokeDasharray={state === "done" ? undefined : "4 6"}
        className={state === "done" ? "cf-draw" : state === "running" ? "cf-flow" : ""}
      />
    </svg>
  );
}
