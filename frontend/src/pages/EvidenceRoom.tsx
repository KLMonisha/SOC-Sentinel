import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "@/api/client";
import type { CaseDetail } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { AnalysisPanel } from "@/features/evidence/AnalysisPanel";
import { CaseHeader } from "@/features/evidence/CaseHeader";
import { Constellation } from "@/features/evidence/Constellation";
import { EvidenceList } from "@/features/evidence/EvidenceList";
import { Inspector } from "@/features/evidence/Inspector";
import { InvestigationProvider, useInvestigation } from "@/features/evidence/InvestigationProvider";
import { Timeline } from "@/features/evidence/Timeline";

type Load = { kind: "loading" } | { kind: "error"; error: ApiError | Error } | { kind: "ready"; data: CaseDetail };

const tab = (active: boolean) =>
  `px-3 py-1.5 text-[12px] border-b-2 ${active ? "border-verified text-ink" : "border-transparent text-ink-muted hover:text-ink"}`;

function Workspace() {
  const { state, dispatch, graph, layout, highlight, fullGraph, selectNode } = useInvestigation();
  const reduce = useReducedMotion();
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4">
        <Panel
          title="Evidence constellation"
          meta={
            <span role="tablist" aria-label="Evidence view" className="flex gap-1">
              <button role="tab" aria-selected={state.view === "graph"} className={tab(state.view === "graph")} onClick={() => dispatch({ type: "setView", view: "graph" })}>Graph</button>
              <button role="tab" aria-selected={state.view === "list"} className={tab(state.view === "list")} onClick={() => dispatch({ type: "setView", view: "list" })}>List</button>
            </span>
          }
        >
          {fullGraph.warnings.length > 0 && (
            <ul role="status" className="mb-2 text-[11px] text-suspicious">
              {fullGraph.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {state.view === "graph" ? (
            <Constellation
              graph={graph} layout={layout} highlight={highlight} selection={state.selection}
              onSelectNode={selectNode}
              onSelectEdge={(id) => dispatch({ type: "select", selection: { kind: "edge", id } })}
              onClear={() => dispatch({ type: "clear" })}
            />
          ) : (
            <EvidenceList />
          )}
        </Panel>
        <Timeline />
      </div>

      <aside aria-label="Investigation details" className="min-w-0 self-start xl:sticky xl:top-4 border border-line bg-surface">
        <div role="tablist" aria-label="Details" className="flex border-b border-line px-2">
          <button role="tab" aria-selected={state.panel === "analysis"} className={tab(state.panel === "analysis")} onClick={() => dispatch({ type: "setPanel", panel: "analysis" })}>Analysis</button>
          <button role="tab" aria-selected={state.panel === "inspector"} className={tab(state.panel === "inspector")} onClick={() => dispatch({ type: "setPanel", panel: "inspector" })}>Inspector</button>
        </div>
        <div className="max-h-[calc(100vh-180px)] overflow-auto p-4">
          <motion.div
            key={state.panel === "inspector" ? `i:${state.selection?.id ?? ""}` : "a"}
            initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
          >
            {state.panel === "analysis" ? <AnalysisPanel /> : <Inspector />}
          </motion.div>
        </div>
      </aside>
    </div>
  );
}

export function EvidenceRoom() {
  const { caseId = "" } = useParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const fetchCase = useCallback(async (signal?: AbortSignal) => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", data: await api.getCase(caseId, signal) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setLoad({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading the case.") });
    }
  }, [caseId]);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchCase(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchCase]);

  if (load.kind === "loading") return <p role="status" className="text-[13px] text-ink-muted">Loading case…</p>;

  if (load.kind === "error") {
    const requestId = "requestId" in load.error ? load.error.requestId : null;
    return (
      <div role="alert" className="mx-auto max-w-xl border border-critical/40 p-4 text-[13px]">
        <p className="text-critical">Could not open case {caseId}.</p>
        <p className="mt-1 text-ink-muted">{load.error.message}
          {requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {requestId}</span>}</p>
        <div className="mt-3 flex gap-2">
          <button onClick={() => void fetchCase()} className="border border-line-strong bg-surface-2 px-3 py-1.5 hover:bg-surface-3">Retry</button>
          <Link to="/" className="border border-line-strong px-3 py-1.5 hover:bg-surface-2">Back to Command Center</Link>
        </div>
      </div>
    );
  }

  return (
    // key: a different case resets replay and selection.
    <InvestigationProvider key={load.data.summary.case_id} caseDetail={load.data}>
      <div className="mx-auto max-w-[1680px] space-y-4">
        <CaseHeader />
        {load.data.events.length === 0 ? (
          <EmptyState title="No source events" detail="This case has no stored source events to explore." />
        ) : (
          <Workspace />
        )}
      </div>
    </InvestigationProvider>
  );
}

export function EvidenceRoomIndex() {
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState title="No case selected" detail="Open a case from the Command Center queue to enter its Evidence Room." />
      <p className="mt-3 text-center"><Link to="/" className="text-[13px] underline underline-offset-2">Go to Command Center</Link></p>
    </div>
  );
}
