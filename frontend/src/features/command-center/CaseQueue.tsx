import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Search } from "lucide-react";
import type { ApiError } from "@/api/client";
import type { CaseSummary, CaseStatus, RiskBand, Severity } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { VerdictLabel } from "@/components/ui/Badges";
import { STATUS_LABEL, formatTime } from "@/lib/format";
import { filterCases, type CaseFilters } from "./filterCases";

export type QueueState =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError | Error }
  | { kind: "ready"; cases: CaseSummary[] };

const EDGE: Record<Severity, string> = { critical: "#d6595f", high: "rgba(214,89,95,0.55)", medium: "#aabdb6", low: "#3d5a50" };
const BAND: Record<RiskBand, string> = { high: "#d6595f", investigate: "#e8a15d", low: "#63ebd8" };

function Seg<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center">
      {options.map((o) => (
        <button
          key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] transition-colors ${
            value === o.value ? "bg-verified/12 text-verified shadow-[inset_0_-1px_0_#63ebd8]" : "text-ink-faint hover:text-ink"}`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function CaseQueue({ state, onRetry, filters, onFilters, hoverId, onHover }: {
  state: QueueState;
  onRetry: () => void;
  filters: CaseFilters;
  onFilters: (f: CaseFilters) => void;
  hoverId?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const visible = useMemo(
    () => (state.kind === "ready" ? filterCases(state.cases, filters) : []),
    [state, filters],
  );

  return (
    <section aria-label="Case queue">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <h2 className="t-micro text-ink">Case queue</h2>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            {state.kind === "ready" ? `${visible.length} of ${state.cases.length} cases` : " "}
          </p>
        </div>

        {state.kind === "ready" && state.cases.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex min-w-64 items-center gap-2.5 border-b border-line-strong pb-1.5 focus-within:border-verified">
              <Search size={14} aria-hidden className="text-ink-faint" />
              <span className="sr-only">Search cases</span>
              <input
                value={filters.query}
                onChange={(e) => onFilters({ ...filters, query: e.target.value })}
                placeholder="Search title, user, IP, host, verdict"
                className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-ink-faint"
              />
            </label>
            <Seg<Severity | "all"> label="Severity" value={filters.severity} onChange={(v) => onFilters({ ...filters, severity: v })}
              options={[{ value: "all", text: "All" }, { value: "critical", text: "Crit" }, { value: "high", text: "High" }, { value: "medium", text: "Med" }, { value: "low", text: "Low" }]} />
            <Seg<CaseStatus | "all"> label="Status" value={filters.status} onChange={(v) => onFilters({ ...filters, status: v })}
              options={[{ value: "all", text: "All" }, ...(Object.keys(STATUS_LABEL) as CaseStatus[]).map((s) => ({ value: s, text: s }))]} />
          </div>
        )}
      </div>

      <div className="mt-5">
        {state.kind === "loading" && <p role="status" className="text-[13px] text-ink-muted">Loading cases…</p>}

        {state.kind === "error" && (
          <div role="alert" className="mat-plane border border-critical/40 p-5 text-[13px]">
            <p className="text-critical">Could not load cases.</p>
            <p className="mt-1 text-ink-muted">
              {state.error.message}
              {"requestId" in state.error && state.error.requestId && (
                <span className="ml-2 font-mono text-xs text-ink-faint">request {state.error.requestId}</span>
              )}
            </p>
            <button onClick={onRetry} className="mt-4 border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">
              Retry
            </button>
          </div>
        )}

        {state.kind === "ready" && state.cases.length === 0 && (
          <EmptyState title="No cases yet" detail="Upload an authentication or web-server log to create investigation cases." />
        )}

        {state.kind === "ready" && state.cases.length > 0 && (visible.length === 0 ? (
          <EmptyState title="No cases match" detail="Adjust the search or filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-separate border-spacing-y-1.5 text-left text-[13.5px]">
              <thead className="text-ink-faint">
                <tr>
                  <th className="t-label px-5 pb-1 font-normal">Case</th>
                  <th className="t-label pb-1 pr-4 font-normal">Severity</th>
                  <th className="t-label pb-1 pr-4 font-normal">Verdict</th>
                  <th className="t-label pb-1 pr-6 font-normal" title="Heuristic 0–100 score. Not a probability.">Risk (heuristic)</th>
                  <th className="t-label pb-1 pr-4 font-normal">Events</th>
                  <th className="t-label pb-1 pr-4 font-normal">Window</th>
                  <th className="t-label pb-1 pr-5 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const lit = hoverId === c.case_id;
                  return (
                    <tr
                      key={c.case_id}
                      onMouseEnter={() => onHover?.(c.case_id)} onMouseLeave={() => onHover?.(null)}
                      onFocus={() => onHover?.(c.case_id)} onBlur={() => onHover?.(null)}
                      className={`group transition-colors duration-300 ${lit ? "mat-lit" : "mat-plane hover:bg-surface-2"} ${c.status !== "open" ? "opacity-70" : ""}`}
                    >
                      <td className="py-3.5 pl-5 pr-4" style={{ boxShadow: `inset 3px 0 0 ${EDGE[c.severity]}` }}>
                        <Link to={`/app/evidence/${encodeURIComponent(c.case_id)}`} className="inline-flex items-center gap-1.5 text-[14.5px] font-medium text-ink">
                          {c.title}
                          <ArrowUpRight size={13} aria-hidden className="text-verified opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-within:opacity-100" />
                        </Link>
                        <div className="mt-1 font-mono text-[11px] text-ink-faint">
                          {c.case_id} · {c.dataset_id} · {c.primary_entities.join(" · ")}
                        </div>
                      </td>
                      <td className="pr-4 text-[12px] uppercase tracking-[0.14em] text-ink-muted">{c.severity}</td>
                      <td className="pr-4"><VerdictLabel verdict={c.verdict} /></td>
                      <td className="pr-6">
                        <div className="flex items-center gap-3">
                          <span className="t-display w-9 text-[16px] tabular-nums">{c.risk_score.value}</span>
                          <span className="block h-[3px] w-24 bg-line" aria-hidden>
                            <span className="block h-full" style={{ width: `${c.risk_score.value}%`, background: BAND[c.risk_score.band] }} />
                          </span>
                          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{c.risk_score.band}</span>
                        </div>
                      </td>
                      <td className="pr-4 font-mono">{c.event_count}</td>
                      <td className="whitespace-nowrap pr-4 font-mono text-[11px] text-ink-muted">{formatTime(c.first_seen).slice(0, 16)}</td>
                      <td className="whitespace-nowrap pr-5 text-ink-muted">{STATUS_LABEL[c.status]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
