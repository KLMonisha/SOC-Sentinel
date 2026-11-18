import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import type { CaseDetail, SourceEvent } from "@/api/types";
import {
  buildGraph, eventIdOfNode, ids, neighborhood, orderEvents, visibleGraph,
  type Highlight, type NormGraph,
} from "./model/graphModel";
import { computeLayout, type Point } from "./model/layout";
import { initialState, investigationReducer, type InvAction, type InvState } from "./model/investigationState";

export const REPLAY_INTERVAL_MS = 900;

export interface InvestigationContextValue {
  caseDetail: CaseDetail;
  state: InvState;
  dispatch: Dispatch<InvAction>;
  orderedEvents: SourceEvent[];
  eventsById: Map<string, SourceEvent>;
  fullGraph: NormGraph;
  graph: NormGraph; // visible at the current replay position
  layout: Record<string, Point>;
  visibleEventIds: Set<string>;
  highlight: Highlight | null;
  selectEvent: (eventId: string) => void;
  selectNode: (nodeId: string) => void;
}

const Ctx = createContext<InvestigationContextValue | null>(null);

export function useInvestigation(): InvestigationContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useInvestigation must be used inside <InvestigationProvider>");
  return v;
}

export function InvestigationProvider({ caseDetail, children }: { caseDetail: CaseDetail; children: ReactNode }) {
  const orderedEvents = useMemo(() => orderEvents(caseDetail.events), [caseDetail.events]);
  const [state, dispatch] = useReducer(investigationReducer, orderedEvents.length, initialState);

  const eventsById = useMemo(() => new Map(orderedEvents.map((e) => [e.event_id, e])), [orderedEvents]);
  const fullGraph = useMemo(() => buildGraph(caseDetail), [caseDetail]);
  const layout = useMemo(
    () => computeLayout(fullGraph, orderedEvents.map((e) => e.event_id)),
    [fullGraph, orderedEvents],
  );
  const visibleEventIds = useMemo(
    () => new Set(orderedEvents.slice(0, state.replay).map((e) => e.event_id)),
    [orderedEvents, state.replay],
  );
  const graph = useMemo(() => visibleGraph(fullGraph, visibleEventIds), [fullGraph, visibleEventIds]);
  const highlight = useMemo(() => neighborhood(graph, state.selection), [graph, state.selection]);

  // Replay clock. Deterministic: one event per tick.
  useEffect(() => {
    if (!state.playing) return;
    const t = setInterval(() => dispatch({ type: "tick" }), REPLAY_INTERVAL_MS);
    return () => clearInterval(t);
  }, [state.playing]);

  // If replay moves back past the selected evidence, drop the selection rather than show a "future" item.
  useEffect(() => {
    const sel = state.selection;
    if (!sel) return;
    const inFull = sel.kind === "node" ? fullGraph.nodes.some((n) => n.id === sel.id) : fullGraph.edges.some((e) => e.id === sel.id);
    const inVisible = sel.kind === "node" ? graph.nodes.some((n) => n.id === sel.id) : graph.edges.some((e) => e.id === sel.id);
    if (inFull && !inVisible) dispatch({ type: "clear" });
  }, [state.selection, fullGraph, graph]);

  const value = useMemo<InvestigationContextValue>(
    () => ({
      caseDetail, state, dispatch, orderedEvents, eventsById, fullGraph, graph, layout, visibleEventIds, highlight,
      // Event ids that do not resolve still become a selection so the inspector can say so explicitly.
      selectEvent: (eventId) => dispatch({ type: "select", selection: { kind: "node", id: ids.event(eventId) } }),
      selectNode: (nodeId) => {
        const evId = eventIdOfNode(nodeId);
        dispatch({ type: "select", selection: { kind: "node", id: evId ? ids.event(evId) : nodeId } });
      },
    }),
    [caseDetail, state, orderedEvents, eventsById, fullGraph, graph, layout, visibleEventIds, highlight],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
