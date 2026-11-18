import { Check, X } from "lucide-react";
import type { DecisionRecord } from "@/api/types";
import { formatTime } from "@/lib/format";

/** Chronological (oldest first) record of every decision the backend returned. Repeated decisions are all shown. */
export function AuditHistory({ decisions }: { decisions: readonly DecisionRecord[] }) {
  const ordered = [...decisions].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at));
  if (ordered.length === 0) {
    return <p className="text-[13px] text-ink-muted">No analyst decision has been recorded for this case.</p>;
  }
  return (
    <ol aria-label="Analyst decision audit history, oldest first" className="space-y-3">
      {ordered.map((d, i) => {
        const approve = d.decision === "approve";
        return (
          <li key={d.decision_id} className="mat-plane relative flex gap-4 px-4 py-3.5">
            <span className={`grid h-8 w-8 shrink-0 place-items-center border ${approve ? "border-verified/60 text-verified" : "border-line-strong text-ink-muted"}`} aria-hidden>
              {approve ? <Check size={15} /> : <X size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="t-micro text-ink">{approve ? "Approved" : "Rejected"}</span>
                <span className="border border-dashed border-line-strong px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Dry run · nothing executed</span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">#{i + 1} · {d.decision_id}</span>
              </div>
              <p className="mt-1.5 text-[13px] text-ink-muted">
                by <span className="font-mono text-ink">{d.analyst_id}</span> · <time dateTime={d.decided_at} className="font-mono text-[12px]">{formatTime(d.decided_at)}</time>
              </p>
              <p className="mt-1.5 text-[13px] text-ink-muted">{d.note ? <>“{d.note}”</> : <span className="text-ink-faint">No note recorded.</span>}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
