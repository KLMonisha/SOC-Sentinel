import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { formatTime } from "@/lib/format";
import { useInvestigation } from "./InvestigationProvider";

/** Accessible / debuggable alternative to the graph. Same data, same selection state. */
export function EvidenceList() {
  const { graph, orderedEvents, visibleEventIds, state, selectEvent, selectNode, dispatch } = useInvestigation();
  const events = orderedEvents.filter((e) => visibleEventIds.has(e.event_id));
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const selNode = state.selection?.kind === "node" ? state.selection.id : null;
  const selEdge = state.selection?.kind === "edge" ? state.selection.id : null;

  return (
    <div className="space-y-5" data-testid="evidence-list">
      <section aria-labelledby="ev-h">
        <h3 id="ev-h" className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Source events ({events.length})</h3>
        <div className="max-h-64 overflow-auto border-y border-line/70">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-bg text-[10px] uppercase tracking-wide text-ink-faint">
              <tr><th className="px-2 py-1.5">Time</th><th>Event</th><th>Type</th><th>User</th><th>IP</th><th>Host</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id} aria-selected={selNode === `event:${e.event_id}`}
                  className={`border-t border-line/60 ${selNode === `event:${e.event_id}` ? "bg-surface-3" : "hover:bg-surface-2"}`}>
                  <td className="px-2 py-1 font-mono text-[11px] text-ink-muted">{formatTime(e.timestamp)}</td>
                  <td>
                    <button type="button" onClick={() => selectEvent(e.event_id)} className="font-mono text-verified underline-offset-2 hover:underline">
                      {e.event_id}
                    </button>
                  </td>
                  <td>{e.event_type}</td>
                  <td>{e.username ?? "—"}</td>
                  <td className="font-mono">{e.source_ip ?? "—"}</td>
                  <td>{e.host ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="rel-h">
        <h3 id="rel-h" className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Relationships ({graph.edges.length})</h3>
        <ul className="max-h-64 divide-y divide-line/60 overflow-auto border-y border-line/70 text-[12px]">
          {graph.edges.map((e) => (
            <li key={e.id} aria-current={selEdge === e.id}>
              <button type="button" onClick={() => dispatch({ type: "select", selection: { kind: "edge", id: e.id } })}
                className={`flex w-full flex-wrap items-center gap-x-2 px-2 py-1 text-left ${selEdge === e.id ? "bg-surface-3" : "hover:bg-surface-2"}`}>
                <span className="font-mono">{label.get(e.source)}</span>
                <span className="text-ink-faint">{e.relation}</span>
                <span className="font-mono">{label.get(e.target)}</span>
                <EvidenceBadge state={e.state} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      {graph.nodes.some((n) => n.kind === "finding" || n.kind === "missing") && (
        <section aria-labelledby="fm-h">
          <h3 id="fm-h" className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">Findings and missing telemetry</h3>
          <ul className="divide-y divide-line/60 border-y border-line/70 text-[12px]">
            {graph.nodes.filter((n) => n.kind === "finding" || n.kind === "missing").map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => selectNode(n.id)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left ${selNode === n.id ? "bg-surface-3" : "hover:bg-surface-2"}`}>
                  <EvidenceBadge state={n.state} />
                  <span>{n.label}</span>
                  {n.stance && <span className="text-ink-faint">· {n.stance}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
