import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "@/api/client";
import type { CaseDetail } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { DecisionPanel } from "@/features/decision/DecisionPanel";
import { ExportPanel } from "@/features/export/ExportPanel";
import { AnalysisPanel } from "@/features/evidence/AnalysisPanel";
import { CaseHeader } from "@/features/evidence/CaseHeader";
import { Constellation } from "@/features/evidence/Constellation";
import { EvidenceList } from "@/features/evidence/EvidenceList";
import { Inspector } from "@/features/evidence/Inspector";
import { InvestigationProvider, useInvestigation } from "@/features/evidence/InvestigationProvider";
import { Timeline } from "@/features/evidence/Timeline";

type Load = { kind: "loading" } | { kind: "error"; error: ApiError | Error } | { kind: "ready"; data: CaseDetail };

const tab = (active: boolean) =>
  `-mb-px min-w-0 flex-1 px-1.5 py-3 text-center text-[11px] uppercase tracking-[0.1em] border-b-2 transition-colors ${active ? "border-verified text-ink" : "border-transparent text-ink-faint hover:text-ink"}`;
const view = (active: boolean) =>
  `px-3 py-1 text-[11px] uppercase tracking-[0.14em] border transition-colors ${active ? "border-verified/60 bg-verified/10 text-verified" : "border-line-strong/70 bg-void/60 text-ink-muted hover:text-ink"}`;

function Workspace({ onReload }: { onReload: () => Promise<void> }) {
  const { state, dispatch, graph, layout, highlight, fullGraph, selectNode, selectEvent, caseDetail } = useInvestigation();
  const reduce = useReducedMotion();

  // The selected event lives in the URL (?event=evt_...) so report citations, refresh and shared links all
  // land on the same evidence. URL -> state first (revealing it if replay had hidden it), then state -> URL.
  const [params, setParams] = useSearchParams();
  const urlEvent = params.get("event");
  const selected = state.selection?.kind === "node" && state.selection.id.startsWith("event:") ? state.selection.id.slice("event:".length) : null;
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (urlEvent && urlEvent !== selected) {
      dispatch({ type: "showAll" });
      selectEvent(urlEvent);
    }
    setSynced(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlEvent]);
  useEffect(() => {
    if (!synced || selected === urlEvent) return;
    const next = new URLSearchParams(params);
    if (selected) next.set("event", selected);
    else next.delete("event");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, synced]);
  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(380px,26vw)]">
      <div className="min-w-0">
        <section aria-label="Evidence constellation" className="room-stage relative border-y border-line/70">
          <div className="flex items-center gap-3 border-b border-line/50 px-5 py-2.5 sm:px-8 lg:px-12">
            <span className="t-micro hidden text-ink sm:inline">Evidence constellation</span>
            <span role="tablist" aria-label="Evidence view" className="flex gap-1">
              <button role="tab" aria-selected={state.view === "graph"} className={view(state.view === "graph")} onClick={() => dispatch({ type: "setView", view: "graph" })}>Graph</button>
              <button role="tab" aria-selected={state.view === "list"} className={view(state.view === "list")} onClick={() => dispatch({ type: "setView", view: "list" })}>List</button>
            </span>
          </div>
          {fullGraph.warnings.length > 0 && (
            <ul role="status" className="absolute bottom-3 left-5 z-[5] max-w-[60ch] text-[11px] text-suspicious sm:left-8 lg:left-12">
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
            <div className="px-5 pb-8 pt-6 sm:px-8 lg:px-12"><EvidenceList /></div>
          )}
        </section>
        <Timeline />
      </div>

      <aside id="room-details" aria-label="Investigation details" className="min-w-0 border-line/70 xl:sticky xl:top-0 xl:flex xl:h-[calc(100dvh-60px)] xl:flex-col xl:border-l">
        <div role="tablist" aria-label="Details" className="flex shrink-0 border-b border-line/70 px-4 sm:px-8 xl:px-5">
          {(["analysis", "inspector", "decision", "export"] as const).map((p) => (
            <button key={p} role="tab" aria-selected={state.panel === p} className={tab(state.panel === p)} onClick={() => dispatch({ type: "setPanel", panel: p })}>
              {p === "analysis" ? "Analysis" : p === "inspector" ? "Inspector" : p === "decision" ? "Decision" : "Export"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8 xl:px-6">
          <motion.div
            key={state.panel === "inspector" ? `i:${state.selection?.id ?? ""}` : state.panel}
            initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
          >
            {state.panel === "analysis" ? <AnalysisPanel /> : state.panel === "decision" ? <DecisionPanel caseDetail={caseDetail} onDecided={onReload} /> : state.panel === "export" ? <ExportPanel detail={caseDetail} compact /> : <Inspector />}
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

  // Re-read the case without resetting replay or selection (used after an analyst decision).
  const reload = useCallback(async () => {
    const data = await api.getCase(caseId);
    setLoad({ kind: "ready", data });
  }, [caseId]);

  if (load.kind === "loading") return <p role="status" className="px-6 py-10 text-[13px] text-ink-muted sm:px-14">Loading case…</p>;

  if (load.kind === "error") {
    const requestId = "requestId" in load.error ? load.error.requestId : null;
    return (
      <div role="alert" className="mx-auto mt-12 max-w-xl border border-critical/40 p-5 text-[13px]">
        <p className="text-critical">Could not open case {caseId}.</p>
        <p className="mt-1 text-ink-muted">{load.error.message}
          {requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {requestId}</span>}</p>
        <div className="mt-3 flex gap-2">
          <button onClick={() => void fetchCase()} className="border border-line-strong bg-surface-2 px-3 py-1.5 hover:bg-surface-3">Retry</button>
          <Link to="/app" className="border border-line-strong px-3 py-1.5 hover:bg-surface-2">Back to Command Center</Link>
        </div>
      </div>
    );
  }

  return (
    // key: a different case resets replay and selection.
    <InvestigationProvider key={load.data.summary.case_id} caseDetail={load.data}>
      <div className="w-full">
        <CaseHeader />
        {load.data.events.length === 0 ? (
          <div className="px-6 py-10 sm:px-14"><EmptyState title="No source events" detail="This case has no stored source events to explore." /></div>
        ) : (
          <Workspace onReload={reload} />
        )}
      </div>
    </InvestigationProvider>
  );
}

export function EvidenceRoomIndex() {
  return (
    <div className="mx-auto mt-12 max-w-xl px-6">
      <EmptyState title="No case selected" detail="Open a case from the Command Center queue to enter its Evidence Room." />
      <p className="mt-3 text-center"><Link to="/app" className="text-[13px] underline underline-offset-2">Go to Command Center</Link></p>
    </div>
  );
}
