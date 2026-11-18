import { memo, useMemo } from "react";
import {
  Background, Controls, Handle, Panel as FlowPanel, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Globe, Server, User, FileText, SearchCheck, CircleDashed } from "lucide-react";
import type { EvidenceState } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Highlight, NodeKind, NormGraph } from "./model/graphModel";
import type { Point } from "./model/layout";
import type { Selection } from "./model/investigationState";

interface NodeData extends Record<string, unknown> {
  label: string;
  sub?: string;
  kind: NodeKind;
  state: EvidenceState;
  dim: boolean;
  stance?: "supporting" | "contradicting";
  critical: boolean;
  unresolved: boolean;
}

const ICON = { user: User, ip: Globe, host: Server, event: FileText, finding: SearchCheck, missing: CircleDashed } as const;

function borderFor(d: NodeData): string {
  if (d.state === "missing") return "border-dashed border-missing text-missing";
  if (d.state === "inferred") return "border-dotted border-suspicious text-suspicious";
  if (d.kind === "finding") {
    if (d.stance === "contradicting") return "border-ink-muted text-ink";
    return d.critical ? "border-critical text-ink" : "border-suspicious text-ink";
  }
  if (d.kind === "event") return "border-line-strong text-ink";
  return "border-verified/70 text-ink";
}

const EvidenceNode = memo(function EvidenceNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const Icon = ICON[data.kind];
  return (
    <div
      className={`w-[190px] border bg-surface-2 px-2.5 py-1.5 text-[12px] transition-opacity ${borderFor(data)} ${
        data.dim ? "opacity-30" : ""} ${selected ? "ring-2 ring-focus" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
      <div className="flex items-center gap-1.5">
        <Icon size={12} aria-hidden className="shrink-0" />
        <span className={`truncate ${data.kind === "event" ? "font-mono" : ""}`}>{data.label}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-ink-faint">
        {data.kind === "finding" && data.stance ? `${data.stance === "supporting" ? "▲ supports" : "▼ contradicts"} · ` : ""}
        {data.sub ?? data.kind}
        {data.state !== "observed" ? ` · ${data.state}` : ""}
        {data.unresolved ? " · unresolved cite" : ""}
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
    </div>
  );
});

const nodeTypes = { evidence: EvidenceNode };

interface Props {
  graph: NormGraph;
  layout: Record<string, Point>;
  highlight: Highlight | null;
  selection: Selection | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClear: () => void;
}

function Flow({ graph, layout, highlight, selection, onSelectNode, onSelectEdge, onClear }: Props) {
  const { fitView } = useReactFlow();

  const nodes = useMemo<Node<NodeData>[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: "evidence",
        position: layout[n.id] ?? { x: 0, y: 0 },
        selected: selection?.kind === "node" && selection.id === n.id,
        ariaLabel: `${n.kind} ${n.label}, ${n.state}${n.stance ? `, ${n.stance} finding` : ""}`,
        data: {
          label: n.label, sub: n.sublabel, kind: n.kind, state: n.state, stance: n.stance,
          critical: n.severity === "critical" || n.severity === "high",
          unresolved: (n.unresolvedEventIds?.length ?? 0) > 0,
          dim: highlight !== null && !highlight.nodeIds.has(n.id),
        },
      })),
    [graph.nodes, layout, highlight, selection],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const dim = highlight !== null && !highlight.edgeIds.has(e.id);
        const stroke = e.state === "observed" ? "#55d6c2" : e.state === "inferred" ? "#e8a15d" : "#8a9bb0";
        return {
          id: e.id, source: e.source, target: e.target,
          selected: selection?.kind === "edge" && selection.id === e.id,
          ariaLabel: `${e.state} relationship ${e.relation}`,
          label: e.state === "observed" ? undefined : `${e.relation} (${e.state})`,
          labelStyle: { fill: "#9db0c3", fontSize: 10 },
          labelBgStyle: { fill: "#0b111b" },
          style: {
            stroke, strokeWidth: highlight?.edgeIds.has(e.id) ? 2 : 1, opacity: dim ? 0.12 : 0.85,
            strokeDasharray: e.state === "missing" ? "5 4" : e.state === "inferred" ? "2 3" : undefined,
          },
        };
      }),
    [graph.edges, highlight, selection],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onSelectionChange={({ nodes: ns, edges: es }) => {
        const n = ns[0];
        const e = es[0];
        if (n && !(selection?.kind === "node" && selection.id === n.id)) onSelectNode(n.id);
        else if (!n && e && !(selection?.kind === "edge" && selection.id === e.id)) onSelectEdge(e.id);
      }}
      onPaneClick={onClear}
    >
      <Background gap={24} color="#243a50" />
      <Controls showInteractive={false} position="bottom-left" />
      <FlowPanel position="top-right">
        <button
          type="button"
          onClick={() => { onClear(); void fitView({ duration: 200 }); }}
          className="border border-line-strong bg-surface-2 px-2.5 py-1 text-[12px] hover:bg-surface-3"
        >
          Reset view
        </button>
      </FlowPanel>
    </ReactFlow>
  );
}

export function Constellation(props: Props) {
  if (props.graph.nodes.length === 0) {
    return <EmptyState title="Nothing revealed yet" detail="No evidence is visible at this replay position." />;
  }
  return (
    <div className="h-[520px] border border-line bg-bg" aria-label="Evidence constellation graph">
      <ReactFlowProvider>
        <Flow {...props} />
      </ReactFlowProvider>
    </div>
  );
}
