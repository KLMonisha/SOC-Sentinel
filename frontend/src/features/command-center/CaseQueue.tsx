import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import type { ApiError } from "@/api/client";
import type { CaseSummary, CaseStatus, Severity } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { SeverityBadge, VerdictLabel } from "@/components/ui/Badges";
import { STATUS_LABEL, formatTime } from "@/lib/format";
import { NO_FILTERS, filterCases, type CaseFilters } from "./filterCases";

export type QueueState =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError | Error }
  | { kind: "ready"; cases: CaseSummary[] };

const selectCls = "border border-line-strong bg-surface-2 px-2 py-1.5 text-[13px]";

export function CaseQueue({ state, onRetry }: { state: QueueState; onRetry: () => void }) {
  const [filters, setFilters] = useState<CaseFilters>(NO_FILTERS);
  const visible = useMemo(
    () => (state.kind === "ready" ? filterCases(state.cases, filters) : []),
    [state, filters],
  );

  return (
    <Panel title="Case queue" meta={state.kind === "ready" ? `${visible.length} of ${state.cases.length}` : undefined}>
      {state.kind === "loading" && <p role="status" className="text-[13px] text-ink-muted">Loading cases…</p>}

      {state.kind === "error" && (
        <div role="alert" className="border border-critical/40 p-4 text-[13px]">
          <p className="text-critical">Could not load cases.</p>
          <p className="mt-1 text-ink-muted">
            {state.error.message}
            {"requestId" in state.error && state.error.requestId && (
              <span className="ml-2 font-mono text-xs text-ink-faint">request {state.error.requestId}</span>
            )}
          </p>
          <button onClick={onRetry} className="mt-3 border border-line-strong bg-surface-2 px-3 py-1.5 hover:bg-surface-3">
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && state.cases.length === 0 && (
        <EmptyState title="No cases yet" detail="Upload an authentication or web-server log to create investigation cases." />
      )}

      {state.kind === "ready" && state.cases.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex min-w-56 flex-1 items-center gap-2 border border-line-strong bg-surface-2 px-2 py-1.5">
              <Search size={14} aria-hidden className="text-ink-faint" />
              <span className="sr-only">Search cases</span>
              <input
                value={filters.query}
                onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                placeholder="Search title, user, IP, host, verdict"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-faint"
              />
            </label>
            <label className="text-[13px]">
              <span className="sr-only">Severity</span>
              <select className={selectCls} value={filters.severity}
                onChange={(e) => setFilters({ ...filters, severity: e.target.value as Severity | "all" })}>
                <option value="all">All severities</option>
                {(["critical", "high", "medium", "low"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-[13px]">
              <span className="sr-only">Status</span>
              <select className={selectCls} value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value as CaseStatus | "all" })}>
                <option value="all">All statuses</option>
                {(Object.keys(STATUS_LABEL) as CaseStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
          </div>

          {visible.length === 0 ? (
            <EmptyState title="No cases match" detail="Adjust the search or filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wide text-ink-faint">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3 font-medium">Case</th>
                    <th className="pr-3 font-medium">Severity</th>
                    <th className="pr-3 font-medium">Verdict</th>
                    <th className="pr-3 font-medium" title="Heuristic 0–100 score. Not a probability.">Risk (heuristic)</th>
                    <th className="pr-3 font-medium">Events</th>
                    <th className="pr-3 font-medium">Window</th>
                    <th className="font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.case_id} className="border-b border-line/60 hover:bg-surface-2">
                      <td className="py-2.5 pr-3">
                        <Link to={`/app/evidence/${encodeURIComponent(c.case_id)}`} className="text-ink underline-offset-2 hover:underline">
                          {c.title}
                        </Link>
                        <div className="font-mono text-[11px] text-ink-faint">
                          {c.case_id} · {c.dataset_id} · {c.primary_entities.join(" · ")}
                        </div>
                      </td>
                      <td className="pr-3"><SeverityBadge severity={c.severity} /></td>
                      <td className="pr-3"><VerdictLabel verdict={c.verdict} /></td>
                      <td className="pr-3 font-mono">{c.risk_score.value}<span className="text-ink-faint"> · {c.risk_score.band}</span></td>
                      <td className="pr-3 font-mono">{c.event_count}</td>
                      <td className="pr-3 font-mono text-[11px] text-ink-muted">{formatTime(c.first_seen)}</td>
                      <td className="text-ink-muted">{STATUS_LABEL[c.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
