import { Link } from "react-router-dom";
import { Play, RotateCw, TriangleAlert } from "lucide-react";
import type { InvestigateRequest, PlannerCandidate } from "@/api/types";
import type { Budget, Failure } from "./model";

export type RunState =
  | { kind: "idle" }
  | { kind: "executing"; attempt: number }
  | { kind: "failed"; failure: Failure; message: string; requestId: string | null; retryable: boolean };

const FAILURE_TITLE: Record<Failure, string> = {
  budget_exhausted: "The backend reports the budget is exhausted",
  timeout: "The request timed out",
  unavailable: "The backend could not be reached",
  invalid_case: "The case could not be found",
  unsupported_tool: "The backend rejected this request",
  key_conflict: "The idempotency key conflicted with an earlier request",
  failed: "The query failed",
};

/** The dynamic stage: shows the exact request that would be (or was) sent, the in-flight state, or the failure. */
export function ExecutionStage({ candidate, request, keyShown, run, budget, onExecute, onRetry, timeoutSec, mock }: {
  candidate: PlannerCandidate | null;
  request: InvestigateRequest | null;
  keyShown: string | null;
  run: RunState;
  budget: Budget;
  onExecute: () => void;
  onRetry: () => void;
  timeoutSec: number;
  mock: boolean;
}) {
  const executing = run.kind === "executing";
  return (
    <section aria-labelledby="inv-stage-h" className={`mat-raised brk relative px-6 py-6 sm:px-8 ${executing ? "inv-scan" : ""}`} data-testid="execution-stage" data-run={run.kind}>
      <i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden />
      <h2 id="inv-stage-h" className="t-micro text-ink">Execution stage</h2>

      {!candidate && (
        <p className="mt-5 max-w-[52ch] text-[14px] leading-relaxed text-ink-muted" role="status">
          {budget.exhausted ? "The query budget is exhausted. No further evidence can be requested for this case." : "Select a proposed query to see exactly what would be sent. Nothing runs until you execute it."}
        </p>
      )}

      {candidate && (
        <>
          <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div className="min-w-0">
              <p className="t-label">Request</p>
              <p className="mt-2 font-mono text-[14px] text-verified">POST /investigate · {candidate.tool}</p>
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[12.5px]">
                {Object.entries(request?.params ?? {}).map(([k, v]) => (<div key={k}><dt className="text-ink-faint">{k}</dt><dd className="break-all text-ink">{v}</dd></div>))}
                <div><dt className="text-ink-faint">idempotency_key</dt><dd className="break-all text-ink-muted" data-testid="idempotency-key">{keyShown ?? "assigned when you execute"}</dd></div>
              </dl>
            </div>
            <button
              type="button" onClick={onExecute} disabled={executing || budget.exhausted || run.kind === "failed"}
              className="brk inline-flex items-center justify-center gap-3 border border-verified/60 bg-verified/10 px-6 py-3.5 text-[11.5px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play size={13} aria-hidden /> {executing ? "Executing…" : run.kind === "failed" ? "Resolve the problem first" : `Execute · uses 1 of ${budget.remaining} remaining`}
            </button>
          </div>
          {!executing && run.kind === "idle" && <p className="mt-4 text-[12px] text-ink-faint">Retrieves events that already exist in the loaded dataset. Results come back with source-file provenance; nothing is generated.</p>}
          {executing && (
            <p role="status" className="mt-5 text-[13.5px] text-ink-muted">
              {run.attempt > 1 ? `Retrying with the same idempotency key (attempt ${run.attempt}). The backend should not charge the budget twice. ` : "Waiting for the backend. "}
              Gives up after {timeoutSec} s.
              {mock && <span className="text-ink-faint"> (Development fixture.)</span>}
            </p>
          )}
        </>
      )}

      {run.kind === "failed" && (
        <div role="alert" className="mt-6 border-l-2 border-critical bg-critical/5 px-5 py-4 text-[13.5px]" data-testid="run-error" data-failure={run.failure}>
          <p className="flex items-center gap-2 text-critical"><TriangleAlert size={14} aria-hidden />{FAILURE_TITLE[run.failure]}</p>
          <p className="mt-1.5 text-ink-muted">{run.message}{run.requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {run.requestId}</span>}</p>
          {run.failure === "budget_exhausted" && <p className="mt-2 text-ink-faint">The budget is now locked. No further queries can be submitted for this case.</p>}
          {run.failure === "invalid_case" && <p className="mt-3"><Link to="/app/investigation" className="text-verified underline-offset-2 hover:underline">Choose another case</Link></p>}
          {run.retryable && (
            <>
              <p className="mt-2 text-ink-faint">The backend may or may not have run the query. Retrying re-sends the <em>same</em> idempotency key, so the budget is not charged twice.</p>
              <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10"><RotateCw size={13} aria-hidden />Retry with the same key</button>
            </>
          )}
          {!run.retryable && run.failure !== "budget_exhausted" && run.failure !== "invalid_case" && <p className="mt-2 text-ink-faint">Nothing was changed. Select a query to try again; a new attempt uses a new key.</p>}
        </div>
      )}
    </section>
  );
}
