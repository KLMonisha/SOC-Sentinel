import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, Controls, Handle, Panel as FlowPanel, Position, ReactFlow, ReactFlowProvider, getViewportForBounds,
  useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Crosshair, Focus, Globe, LocateFixed, Server, User, Video } from "lucide-react";
import type { EvidenceState } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { FRAME_PADDING, MAX_FRAME_ZOOM, MIN_ZOOM, cameraDuration, isComfortablyVisible, shouldMoveCamera } from "./camera";
import { useInvestigation } from "./InvestigationProvider";
import type { Highlight, NodeKind, NormGraph } from "./model/graphModel";
import { SHAPE, clipToShape, layoutBounds, type Point } from "./model/layout";
import type { Selection } from "./model/investigationState";

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
};

const STROKE: Record<EvidenceState, string> = { observed: "#63ebd8", inferred: "#e8a15d", missing: "#8fa39d" };
const DASH: Record<EvidenceState, string | undefined> = { observed: undefined, inferred: "2 3", missing: "5 4" };

interface NodeData extends Record<string, unknown> {
  label: string;
  caption: string;
  kind: NodeKind;
  state: EvidenceState;
  /** 0 = normal, 1 = dimmed by selection, 2 = pushed back by Focus Mode. */
  dim: 0 | 1 | 2;
  stance?: "supporting" | "contradicting";
  critical: boolean;
  unresolved: boolean;
  anchor: boolean;
  active: boolean;
  time?: string;
  enter: boolean;
}

/** Silhouette. Shape + stroke style + caption carry the meaning; colour only reinforces it. */
function Silhouette({ d, selected }: { d: NodeData; selected: boolean }) {
  const { w, h } = SHAPE[d.kind];
  const stroke = STROKE[d.state];
  const sw = selected ? 2.5 : 1.5;
  const common = { fill: "#0e1a16", stroke, strokeWidth: sw, strokeDasharray: DASH[d.state] } as const;
  switch (d.kind) {
    case "user":
      return (
        <svg width={w} height={h} aria-hidden>
          {d.anchor && <circle cx={w / 2} cy={h / 2} r={w / 2 + 4} fill="none" stroke="#2a4a41" strokeWidth={1} />}
          <circle cx={w / 2} cy={h / 2} r={w / 2 - 1.5} {...common} />
        </svg>
      );
    case "ip":
      return (
        <svg width={w} height={h} aria-hidden>
          <polygon points={`${w * 0.25},2 ${w * 0.75},2 ${w - 2},${h / 2} ${w * 0.75},${h - 2} ${w * 0.25},${h - 2} 2,${h / 2}`} {...common} />
        </svg>
      );
    case "host":
      return (
        <svg width={w} height={h} aria-hidden>
          <rect x={2} y={2} width={w - 4} height={h - 4} rx={4} {...common} />
          <line x1={2} y1={12} x2={w - 2} y2={12} stroke={stroke} strokeWidth={1} opacity={0.5} />
          <circle cx={10} cy={7} r={1.6} fill={stroke} />
          <circle cx={17} cy={7} r={1.6} fill={stroke} opacity={0.5} />
        </svg>
      );
    case "missing":
      return (
        <svg width={w} height={h} aria-hidden>
          <circle cx={w / 2} cy={h / 2} r={w / 2 - 2} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray="5 4" />
        </svg>
      );
    default:
      return null;
  }
}

const GLYPH = { user: User, ip: Globe, host: Server } as const;

const EvidenceNode = memo(function EvidenceNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const [enter] = useState(data.enter); // captured at mount: only nodes that APPEAR later animate in
  const { w, h } = SHAPE[data.kind];
  const dim = data.dim === 2 ? "opacity-[0.07] pointer-events-none" : data.dim === 1 ? "opacity-30" : "";
  const Glyph = data.kind === "user" || data.kind === "ip" || data.kind === "host" ? GLYPH[data.kind] : null;
  const accent = data.stance === "contradicting" ? "#9bb0aa" : data.critical ? "#d6595f" : "#e8a15d";

  return (
    <div
      className={`group relative transition-opacity duration-300 ${dim} ${enter ? "ev-node-in" : ""}`}
      style={{ width: w, height: h }}
    >
      <Handle type="target" position={Position.Top} className="!pointer-events-none !h-px !w-px !border-0 !bg-transparent" style={{ left: "50%", top: "50%" }} />
      <Handle type="source" position={Position.Top} className="!pointer-events-none !h-px !w-px !border-0 !bg-transparent" style={{ left: "50%", top: "50%" }} />

      {selected && data.kind !== "event" && data.kind !== "finding" && (
        <span className="absolute -inset-1.5 rounded-full border border-focus" aria-hidden />
      )}
      {data.active && <span className="ev-active-ring absolute -inset-1.5 rounded-full border border-verified" aria-hidden />}

      {data.kind === "event" ? (
        <div
          className={`flex h-full items-center gap-1.5 rounded-full border bg-surface-2 px-2.5 font-mono text-[10.5px] transition-colors group-hover:bg-surface-3 ${
            selected ? "border-focus ring-1 ring-focus" : "border-verified/60"} ${data.active ? "ring-1 ring-verified" : ""}`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-verified" aria-hidden />
          <span className="text-ink-muted">{data.time}</span>
          <span className="truncate text-ink">{data.label}</span>
        </div>
      ) : data.kind === "finding" ? (
        <div
          className={`flex h-full items-center gap-2 overflow-hidden border bg-surface-2 pr-2 text-[11px] transition-colors group-hover:bg-surface-3 ${
            selected ? "border-focus ring-1 ring-focus" : "border-line-strong"} ${data.state === "inferred" ? "border-dotted" : ""}`}
        >
          <span className="h-full w-1 shrink-0" style={{ background: accent }} aria-hidden />
          <span className="shrink-0 text-[10px]" style={{ color: accent }} aria-hidden>{data.stance === "contradicting" ? "▼" : "▲"}</span>
          <span className="truncate text-ink">{data.label}</span>
        </div>
      ) : (
        <>
          <Silhouette d={data} selected={selected} />
          {Glyph && (
            <Glyph size={data.kind === "user" ? 22 : 16} aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-ink-muted group-hover:text-ink"
              style={{ marginTop: data.kind === "host" ? 4 : 0 }} />
          )}
          {data.kind === "missing" && <span className="absolute inset-0 flex items-center justify-center font-mono text-[18px] text-missing" aria-hidden>?</span>}
        </>
      )}

      {data.kind !== "event" && data.kind !== "finding" && (
        <div className="pointer-events-none absolute left-1/2 top-full mt-2 w-[128px] -translate-x-1/2 text-center">
          <div className={`truncate text-[11.5px] leading-tight text-ink ${data.kind === "ip" ? "font-mono" : ""}`}>{data.label}</div>
          <div className="mt-0.5 text-[9.5px] uppercase tracking-wider text-ink-faint">{data.caption}</div>
        </div>
      )}
      {data.kind === "finding" && (
        <div className="pointer-events-none absolute left-1 top-full mt-1 text-[9.5px] uppercase tracking-wider text-ink-faint">
          {data.stance === "contradicting" ? "contradicts" : "supports"} · {data.caption}
        </div>
      )}
    </div>
  );
});

interface EdgeData extends Record<string, unknown> {
  p1: Point;
  p2: Point;
  state: EvidenceState;
  relation: string;
  mode: "rest" | "active" | "dim" | "hidden";
  enter: boolean;
}

/** Straight, silhouette-clipped line. No arrowheads: relationships are observed associations, not causal flow. */
const EvidenceEdge = memo(function EvidenceEdge({ id, data, selected }: EdgeProps<Edge<EdgeData>>) {
  const [enter] = useState(data?.enter ?? false);
  const [hover, setHover] = useState(false);
  if (!data) return null;
  const { p1, p2, state, mode } = data;
  const path = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
  const strong = mode === "active" || selected;
  const opacity = mode === "hidden" ? 0.03 : mode === "dim" ? 0.1 : strong ? 1 : state === "observed" ? 0.34 : 0.6;
  const showLabel = (strong || hover) && mode !== "hidden";
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} data-edge-id={id}>
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} className="react-flow__edge-interaction" />
      <path
        d={path} fill="none" stroke={STROKE[state]} strokeWidth={strong ? 2 : 1}
        strokeDasharray={DASH[state]} strokeLinecap="round" opacity={opacity}
        className={`ev-edge ${enter ? "ev-edge-in" : ""}`}
      />
      {showLabel && (
        <text x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 6} textAnchor="middle" className="fill-ink-muted font-mono" fontSize={10}
          style={{ paintOrder: "stroke", stroke: "#050b0a", strokeWidth: 4 }}>
          {data.relation.replace(/_/g, " ")}{state !== "observed" ? ` (${state})` : ""}
        </text>
      )}
    </g>
  );
});

const nodeTypes = { evidence: EvidenceNode };
const edgeTypes = { evidence: EvidenceEdge };

interface Props {
  graph: NormGraph;
  layout: Record<string, Point>;
  highlight: Highlight | null;
  selection: Selection | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClear: () => void;
}

const tool =
  "inline-flex items-center gap-1.5 border border-line-strong bg-surface-2 px-2 py-1 text-[11.5px] text-ink-muted hover:bg-surface-3 hover:text-ink disabled:opacity-40 aria-pressed:border-verified/70 aria-pressed:text-ink";

function Flow({ graph, layout, highlight, selection, onSelectNode, onSelectEdge, onClear }: Props) {
  const { setViewport, getViewport } = useReactFlow();
  const { state, dispatch, fullGraph, eventsById, orderedEvents, activeEventId } = useInvestigation();
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const ready = useRef(false); // false until after first paint; later arrivals animate in
  const [inited, setInited] = useState(false);

  const fullBounds = useMemo(() => layoutBounds(fullGraph, layout), [fullGraph, layout]);
  const sizeOf = () => ({ width: wrap.current?.clientWidth ?? 0, height: wrap.current?.clientHeight ?? 0 });

  const frame = useCallback(
    (b: ReturnType<typeof layoutBounds>, ms: number) => {
      const size = sizeOf();
      if (!b || size.width === 0) return;
      const v = getViewportForBounds(b, size.width, size.height, MIN_ZOOM, MAX_FRAME_ZOOM, FRAME_PADDING);
      void setViewport(v, { duration: cameraDuration(reduced, ms) });
    },
    [reduced, setViewport],
  );

  // Initial composition: frame the FULL graph so replayed evidence appears where the camera already is.
  useEffect(() => {
    if (!inited) return;
    frame(fullBounds, 0);
    const t = setTimeout(() => { ready.current = true; }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inited]);

  // Camera: selection / focus / replay follow.
  const firstSel = useRef(true);
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return; }
    if (!selection || !highlight) return;
    const b = layoutBounds(graph, layout, highlight.nodeIds);
    if (!b) return;
    const visible = isComfortablyVisible(b, getViewport(), sizeOf());
    if (shouldMoveCamera({ cause: state.cause, follow: state.follow, force: state.focus, visible, zoom: getViewport().zoom })) frame(b, 400);
    // Only a change of selection or focus moves the camera, never a graph re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.id, state.focus]);

  const isFirst = !ready.current;
  const focusing = state.focus && highlight !== null;

  const nodes = useMemo<Node<NodeData>[]>(() => {
    const anchorId = [...fullGraph.nodes].find((n) => n.kind === "user" && layout[n.id]?.x === 0 && layout[n.id]?.y === 0)?.id;
    return graph.nodes.map((n) => {
      const ev = n.eventId ? eventsById.get(n.eventId) : undefined;
      const inHl = highlight === null || highlight.nodeIds.has(n.id);
      return {
        id: n.id,
        type: "evidence",
        position: layout[n.id] ?? { x: 0, y: 0 },
        selected: selection?.kind === "node" && selection.id === n.id,
        ariaLabel: `${n.kind} ${n.label}, ${n.state}${n.stance ? `, ${n.stance} finding` : ""}`,
        data: {
          label: n.label,
          caption: n.kind === "finding" ? (n.sublabel ?? "finding") : n.state !== "observed" ? `${n.sublabel ?? n.kind} · ${n.state}` : (n.sublabel ?? (n.kind === "user" ? "identity" : n.kind)),
          kind: n.kind, state: n.state, stance: n.stance,
          critical: n.severity === "critical" || n.severity === "high",
          unresolved: (n.unresolvedEventIds?.length ?? 0) > 0,
          dim: inHl ? 0 : focusing ? 2 : 1,
          anchor: n.id === anchorId,
          active: ev !== undefined && ev.event_id === activeEventId,
          time: ev ? clock(ev.timestamp) : undefined,
          enter: !isFirst,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, layout, highlight, selection, focusing, activeEventId, eventsById, fullGraph.nodes]);

  const kindOf = useMemo(() => new Map(fullGraph.nodes.map((n) => [n.id, n.kind])), [fullGraph.nodes]);

  const edges = useMemo<Edge<EdgeData>[]>(
    () =>
      graph.edges.flatMap((e) => {
        const a = layout[e.source];
        const b = layout[e.target];
        const ka = kindOf.get(e.source);
        const kb = kindOf.get(e.target);
        if (!a || !b || !ka || !kb) return [];
        const inHl = highlight?.edgeIds.has(e.id) ?? false;
        const mode: EdgeData["mode"] = highlight === null ? "rest" : inHl ? "active" : focusing ? "hidden" : "dim";
        return [{
          id: e.id, source: e.source, target: e.target, type: "evidence",
          selected: selection?.kind === "edge" && selection.id === e.id,
          ariaLabel: `${e.state} relationship ${e.relation}`,
          data: { p1: clipToShape(a, b, ka), p2: clipToShape(b, a, kb), state: e.state, relation: e.relation, mode, enter: !isFirst },
        }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.edges, layout, highlight, selection, focusing, kindOf],
  );

  const hud = state.replay < state.total || state.playing ? orderedEvents[state.replay - 1] : undefined;
  const canFocus = selection !== null;

  return (
    <div ref={wrap} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodeOrigin={[0.5, 0.5]}
        defaultViewport={{ x: 0, y: 0, zoom: 0.7 }}
        onInit={() => setInited(true)}
        minZoom={MIN_ZOOM}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        // A real user gesture (event != null) hands the camera back to the analyst.
        onMoveStart={(ev) => { if (ev) dispatch({ type: "setFollow", follow: false }); }}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          const n = ns[0];
          const e = es[0];
          if (n && !(selection?.kind === "node" && selection.id === n.id)) onSelectNode(n.id);
          else if (!n && e && !(selection?.kind === "edge" && selection.id === e.id)) onSelectEdge(e.id);
        }}
        onPaneClick={onClear}
      >
        <Background gap={32} size={1} color="#14231e" />
        <Controls showInteractive={false} position="bottom-left" />

        <FlowPanel position="top-right" className="!m-2 flex gap-1.5">
          <button type="button" className={tool} onClick={() => frame(fullBounds, 400)} aria-label="Reset view to the whole constellation">
            <LocateFixed size={12} aria-hidden /> Reset view
          </button>
          <button type="button" className={tool} aria-pressed={state.follow} onClick={() => dispatch({ type: "setFollow", follow: !state.follow })}
            title="Camera follows evidence as replay reveals it. Any manual pan or zoom turns this off.">
            <Video size={12} aria-hidden /> Follow events
          </button>
          <button type="button" className={tool} aria-pressed={state.focus} disabled={!canFocus && !state.focus}
            onClick={() => dispatch({ type: "setFocus", focus: !state.focus })}
            title="Isolate the selected item and its direct relationships. Nothing is removed from the case.">
            {state.focus ? <Crosshair size={12} aria-hidden /> : <Focus size={12} aria-hidden />} {state.focus ? "Exit focus" : "Focus"}
          </button>
        </FlowPanel>

        {hud && (
          <FlowPanel position="top-left" className="!m-2">
            <div role="status" className="border border-line-strong bg-surface-2/95 px-2.5 py-1.5 font-mono text-[11px]">
              <span className="text-ink-faint">REPLAY {state.replay}/{state.total}</span>
              <span className="ml-2 text-ink">{clock(hud.timestamp)} UTC</span>
              <span className="ml-2 text-verified">{hud.event_id}</span>
            </div>
          </FlowPanel>
        )}

        <FlowPanel position="bottom-right" className="!m-2">
          <div aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-surface/90 px-2.5 py-1.5 text-[10.5px] text-ink-muted">
            <span><span className="text-verified">━</span> observed (from a source log field)</span>
            <span><span className="text-suspicious">┄</span> inferred (hypothesis)</span>
            <span><span className="text-missing">╌ ○</span> missing telemetry</span>
          </div>
        </FlowPanel>
      </ReactFlow>
    </div>
  );
}

export function Constellation(props: Props) {
  if (props.graph.nodes.length === 0) {
    return <EmptyState title="Nothing revealed yet" detail="No evidence is visible at this replay position." />;
  }
  return (
    <div className="h-[clamp(480px,66vh,780px)] border border-line bg-bg" aria-label="Evidence constellation graph">
      <ReactFlowProvider>
        <Flow {...props} />
      </ReactFlowProvider>
    </div>
  );
}
