import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseSummary } from "@/api/types";
import { VerdictLabel } from "@/components/ui/Badges";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { EmptyState } from "@/components/ui/EmptyState";
import { filterCases, NO_FILTERS } from "@/features/command-center/filterCases";

type State = { kind: "loading" } | { kind: "error"; error: ApiError | Error } | { kind: "ready"; cases: CaseSummary[] };

/** Choose the case to investigate. */
export function InvestigationIndex() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    api.listCases(ctrl.signal).then(
      (r) => setState({ kind: "ready", cases: filterCases(r.cases, NO_FILTERS) }),
      (e) => { if (!(e instanceof DOMException && e.name === "AbortError")) setState({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading cases.") }); },
    );
    return () => ctrl.abort();
  }, [nonce]);

  return (
    <div className="mx-auto w-full max-w-[1500px] px-6 pb-24 pt-8 sm:px-10 lg:px-14">
      <p className="t-label mb-4">Investigation lab</p>
      <DisplayTitle lines={["What evidence", "is missing?"]} size="text-[clamp(24px,3.8vw,58px)]" at={4} />
      <p className="mt-6 max-w-[62ch] text-[15px] leading-relaxed text-ink-muted">Choose a case, review what it cannot yet say, and run bounded queries for the evidence that is missing.</p>

      <div className="mt-10">
        {state.kind === "loading" && <p role="status" className="text-[13px] text-ink-muted">Loading cases…</p>}
        {state.kind === "error" && (
          <div role="alert" className="max-w-xl border border-critical/40 p-5 text-[13.5px]">
            <p className="text-critical">Could not load cases.</p>
            <p className="mt-1 text-ink-muted">{state.error.message}</p>
            <button onClick={() => setNonce((n) => n + 1)} className="mt-4 border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Retry</button>
          </div>
        )}
        {state.kind === "ready" && state.cases.length === 0 && <EmptyState title="No cases yet" detail="Ingest a log in the Command Center to create cases to investigate." />}
        {state.kind === "ready" && state.cases.length > 0 && (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {state.cases.map((c) => (
              <li key={c.case_id}>
                <Link to={`/app/investigation/${encodeURIComponent(c.case_id)}`} className="mat-plane brk brk-hover group block px-6 py-5">
                  <span className="flex items-start justify-between gap-4">
                    <span className="text-[15px] font-medium text-ink">{c.title}</span>
                    <ArrowUpRight size={15} aria-hidden className="shrink-0 text-verified opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </span>
                  <span className="mt-2 block font-mono text-[11px] text-ink-faint">{c.case_id} · {c.event_count} events</span>
                  <span className="mt-4 flex items-baseline gap-4">
                    <VerdictLabel verdict={c.verdict} />
                    <span className="t-display text-[16px] tabular-nums">{c.risk_score.value}</span>
                    <span className="text-[11px] uppercase tracking-wider text-ink-faint">{c.risk_score.band}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
