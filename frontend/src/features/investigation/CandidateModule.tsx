import { Check, CircleSlash, Lock, Radio } from "lucide-react";
import type { PlannerCandidate } from "@/api/types";
import { isSupportedTool, TOOL_QUESTION } from "./model";

export type CandidateStatus = "proposed" | "executing" | "retrieved" | "used_earlier" | "unsupported" | "locked";

const STATUS: Record<CandidateStatus, { label: string; note: string }> = {
  proposed: { label: "Proposed", note: "Not run. Nothing has been retrieved." },
  executing: { label: "Executing", note: "Query in flight." },
  retrieved: { label: "Retrieved", note: "Run in this session." },
  used_earlier: { label: "Already run", note: "The backend marks this query as used." },
  unsupported: { label: "Unsupported", note: "This console cannot run this tool." },
  locked: { label: "Locked", note: "No budget remains." },
};

const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;

/** One recommended action. A proposal is a plan, never evidence; the status makes that explicit. */
export function CandidateModule({ candidate, index, status, selected, onSelect, onViewResult, retrievedCount }: {
  candidate: PlannerCandidate;
  index: number;
  status: CandidateStatus;
  selected: boolean;
  onSelect: () => void;
  onViewResult?: () => void;
  retrievedCount?: number;
}) {
  const known = isSupportedTool(candidate.tool);
  const canSelect = status === "proposed" || status === "executing";
  const params = Object.entries(candidate.params ?? {});
  const Icon = status === "retrieved" ? Check : status === "locked" ? Lock : status === "unsupported" ? CircleSlash : Radio;
  const tone = status === "retrieved" ? "text-verified" : status === "locked" || status === "unsupported" ? "text-ink-faint" : status === "executing" ? "text-verified" : "text-suspicious";
  return (
    <article
      className="inv-module mat-plane inv-rise grid gap-x-8 gap-y-5 px-6 py-6 sm:px-8 lg:grid-cols-[64px_minmax(0,1fr)_240px]"
      data-selected={selected} data-rec={candidate.recommended && canSelect} data-locked={status === "locked" || status === "unsupported"}
      data-testid="candidate" data-tool={candidate.tool} data-status={status} style={{ ["--i" as string]: index }}
    >
      <div className="t-display text-[34px] leading-none text-ink-faint" aria-hidden>{String(index + 1).padStart(2, "0")}</div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] ${tone}`} data-testid="candidate-status">
            <Icon size={13} aria-hidden /> {STATUS[status].label}
          </span>
          {candidate.recommended && canSelect && <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-verified">★ Recommended</span>}
        </div>
        <h3 className="mt-3 text-[clamp(17px,1.5vw,21px)] font-medium leading-snug text-ink">
          {known ? TOOL_QUESTION[candidate.tool] : "Unrecognised investigation tool"}
        </h3>
        <p className="mt-1 font-mono text-[12.5px] text-verified" data-testid="candidate-tool">{candidate.tool}</p>
        <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-muted"><span className="t-label mr-2">Why</span>{candidate.reason}</p>

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3" aria-label="Required parameters">
          {params.length === 0 && <div><dt className="t-label">Parameters</dt><dd className="mt-1 text-[12.5px] text-ink-faint">none required</dd></div>}
          {params.map(([k, v]) => (
            <div key={k}><dt className="t-label">{k}</dt><dd className="mt-1 break-all font-mono text-[13px] text-ink" data-testid="candidate-param">{v}</dd></div>
          ))}
        </dl>
        {!known && <p role="note" className="mt-3 text-[12.5px] text-suspicious">The backend proposed “{String(candidate.tool)}”. Only get_related_auth_events, get_post_login_activity and get_ip_context are supported, so this will not be sent.</p>}
      </div>

      <div className="flex flex-col justify-between gap-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
          <div>
            <dt className="t-label">Expected information value</dt>
            <dd className="mt-1.5">
              <span className="font-mono text-[13px] tabular-nums text-ink" data-testid="candidate-gain">{candidate.expected_uncertainty_reduction.toFixed(2)}</span>
              <span className="inv-bar mt-1.5 block" aria-hidden><i style={{ width: pct(candidate.expected_uncertainty_reduction) }} /></span>
            </dd>
          </div>
          <div><dt className="t-label">Relevance</dt><dd className="mt-1.5 font-mono text-[13px] tabular-nums text-ink-muted">{candidate.relevance.toFixed(2)}</dd></div>
          <div><dt className="t-label">Cost</dt><dd className="mt-1.5 font-mono text-[13px] tabular-nums text-ink-muted">{candidate.retrieval_cost} {candidate.retrieval_cost === 1 ? "query" : "queries"}</dd></div>
        </dl>
        <div>
          <p className="mb-2.5 text-[12px] text-ink-faint">{status === "retrieved" && retrievedCount !== undefined ? `Retrieved ${retrievedCount} event${retrievedCount === 1 ? "" : "s"}.` : STATUS[status].note}</p>
          {status === "retrieved" && onViewResult ? (
            <button type="button" onClick={onViewResult} className="w-full border border-line-strong px-4 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:border-ink-muted hover:text-ink">View result</button>
          ) : (
            <button
              type="button" onClick={onSelect} disabled={!canSelect} aria-pressed={selected}
              aria-label={`${selected ? "Selected" : "Select"} ${candidate.tool}${params.length ? ` for ${params.map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`}
              className={`w-full border px-4 py-2.5 text-[11.5px] uppercase tracking-[0.16em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${selected ? "border-verified bg-verified/15 text-verified" : "border-verified/50 text-verified hover:bg-verified/10"}`}
            >
              {selected ? "Selected" : "Select"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
