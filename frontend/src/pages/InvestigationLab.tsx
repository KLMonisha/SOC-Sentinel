import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseDetail, PlannerCandidate } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { EmptyState } from "@/components/ui/EmptyState";
import { VerdictLabel } from "@/components/ui/Badges";
import { AssessmentCompare } from "@/features/investigation/AssessmentCompare";
import { BudgetMeter, StageRail, type StageName } from "@/features/investigation/BudgetAndStage";
import { CandidateModule, type CandidateStatus } from "@/features/investigation/CandidateModule";
import { ExecutionStage, type RunState } from "@/features/investigation/ExecutionStage";
import { ProvenanceLedger } from "@/features/investigation/ProvenanceLedger";
import {
  budgetOf, buildInvestigateRequest, candidateId, classifyFailure, compareAssessment, IdempotencyKeys, isRetryable, isSupportedTool,
  recordStep, sessionSteps, type Step,
} from "@/features/investigation/model";
import "@/features/investigation/investigation.css";
import { evidencePath } from "@/features/report/citations";
import { config } from "@/lib/config";

export const INVESTIGATION_TIMEOUT_MS = 15_000;

type Load = { kind: "loading" } | { kind: "error"; error: ApiError | Error } | { kind: "ready"; data: CaseDetail };

export function InvestigationLab({ timeoutMs = INVESTIGATION_TIMEOUT_MS }: { timeoutMs?: number }) {
  const { caseId = "" } = useParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [c, setC] = useState<CaseDetail | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [confirmedExhausted, setConfirmedExhausted] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"retrieved" | "assessed" | null>(null);

  const keys = useRef(new IdempotencyKeys());
  const lock = useRef(false); // synchronous guard: React state is too late for a double click
  const cRef = useRef<CaseDetail | null>(null);
  const exhaustedRef = useRef(false);
  const inFlight = useRef<AbortController | null>(null);
  cRef.current = c;
  exhaustedRef.current = confirmedExhausted;

  const fetchCase = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.getCase(caseId, signal);
      setLoad({ kind: "ready", data });
      setC(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setLoad({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading the case.") });
    }
  }, [caseId]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ kind: "loading" });
    setC(null);
    const prior = sessionSteps(caseId);
    setSteps(prior);
    setViewId(prior.length ? prior[prior.length - 1]!.id : null);
    setSelected(null); setActiveId(null); setRun({ kind: "idle" }); setConfirmedExhausted(false); setPhase(null);
    keys.current = new IdempotencyKeys();
    void fetchCase(ctrl.signal);
    return () => { ctrl.abort(); inFlight.current?.abort(); };
  }, [caseId, fetchCase]);

  // PROPOSED → EXECUTING → RETRIEVED → ASSESSED: the last step is a short, purely presentational beat.
  useEffect(() => {
    if (phase !== "retrieved") return;
    const t = setTimeout(() => setPhase("assessed"), 650);
    return () => clearTimeout(t);
  }, [phase]);

  const execute = useCallback(async (cand: PlannerCandidate) => {
    const current = cRef.current;
    if (lock.current || !current) return;
    if (budgetOf(current, exhaustedRef.current).exhausted) return;
    lock.current = true;
    const id = candidateId(cand);
    const { key, attempt } = keys.current.begin(id);
    const built = buildInvestigateRequest(cand, key);
    if (!built.request) {
      keys.current.release(id);
      setRun({ kind: "failed", failure: "unsupported_tool", message: built.problems.join(" "), requestId: null, retryable: false });
      lock.current = false;
      return;
    }
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    setActiveId(id);
    setPhase(null);
    setRun({ kind: "executing", attempt });
    try {
      const res = await api.investigate(caseId, built.request, ctrl.signal);
      if (res.case_id !== caseId || res.tool !== cand.tool) {
        keys.current.release(id);
        setRun({ kind: "failed", failure: "failed", message: "The response did not match the request (different case or tool), so it was discarded.", requestId: res.request_id ?? null, retryable: false });
        return;
      }
      const updated: CaseDetail | undefined = res.updated_case as CaseDetail | undefined;
      // Budget comes from the backend's own field. Nothing is decremented locally.
      const base = updated ?? current;
      const next: CaseDetail = { ...base, planner: { ...base.planner, budget_remaining: res.budget_remaining } };
      const step: Step = { id: key, candidateId: id, tool: cand.tool, params: { ...cand.params }, key, attempts: attempt, before: current, response: res, at: new Date().toISOString() };
      recordStep(caseId, step);
      keys.current.release(id);
      setSteps((s) => [...s.filter((x) => x.id !== step.id), step]);
      setC(next);
      setViewId(step.id);
      setSelected(null);
      setRun({ kind: "idle" });
      setPhase("retrieved");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && !timedOut) return; // left the page
      const err = timedOut ? new ApiError(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`, "request_timeout", null, null) : e;
      const failure = classifyFailure(err);
      const retryable = isRetryable(err);
      if (!retryable) keys.current.release(id);
      if (failure === "budget_exhausted") setConfirmedExhausted(true);
      const api_ = err instanceof ApiError ? err : null;
      setRun({ kind: "failed", failure, message: api_?.message ?? "The query could not be run.", requestId: api_?.requestId ?? null, retryable });
    } finally {
      clearTimeout(timer);
      lock.current = false;
    }
  }, [caseId, timeoutMs]);

  const candidates = c?.planner.candidates ?? [];
  const selectedCand = useMemo(() => candidates.find((x) => candidateId(x) === selected) ?? null, [candidates, selected]);
  const view = steps.find((s) => s.id === viewId) ?? null;
  const cmp = useMemo(() => (view ? compareAssessment(view.before, view.response) : null), [view]);

  if (load.kind === "loading") return <p role="status" className="px-6 py-10 text-[13px] text-ink-muted sm:px-14">Loading case…</p>;
  if (load.kind === "error" || !c) {
    const e = load.kind === "error" ? load.error : new Error("Case unavailable.");
    const notFound = e instanceof ApiError && (e.code === "CASE_NOT_FOUND" || e.status === 404);
    const requestId = e instanceof ApiError ? e.requestId : null;
    return (
      <div role="alert" className="mx-auto mt-12 max-w-xl border border-critical/40 p-5 text-[13.5px]" data-testid="load-error">
        <p className="text-critical">{notFound ? `Case ${caseId} does not exist.` : `Could not open case ${caseId}.`}</p>
        <p className="mt-1 text-ink-muted">{e.message}{requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {requestId}</span>}</p>
        <div className="mt-4 flex gap-3">
          {!notFound && <button onClick={() => { setLoad({ kind: "loading" }); void fetchCase(); }} className="border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Retry</button>}
          <Link to="/app/investigation" className="px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">Choose another case</Link>
        </div>
      </div>
    );
  }

  const s = c.summary;
  const budget = budgetOf(c, confirmedExhausted);
  const executing = run.kind === "executing";
  const statusOf = (x: PlannerCandidate): CandidateStatus => {
    if (!isSupportedTool(x.tool)) return "unsupported";
    const id = candidateId(x);
    if (executing && activeId === id) return "executing";
    if (steps.some((st) => st.candidateId === id)) return "retrieved";
    if (x.used) return "used_earlier";
    return budget.exhausted ? "locked" : "proposed";
  };
  const stage: StageName | null = executing || run.kind === "failed" ? "executing" : phase ?? (selectedCand ? "proposed" : null);
  const preview = selectedCand ? buildInvestigateRequest(selectedCand, "preview").request : null;
  const retrievedNew = new Set(cmp?.newEventIds ?? []);
  const mock = config.useMocks;

  return (
    <div className="mx-auto w-full max-w-[1760px] px-6 pb-28 pt-8 sm:px-10 lg:px-14">
      <Link to={evidencePath(s.case_id)} className="inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Evidence Room
      </Link>

      <header className="mt-6 flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
        <div>
          <p className="t-label mb-4">Investigation lab · {s.case_id}</p>
          <DisplayTitle lines={["What evidence", "is missing?"]} size="text-[clamp(26px,4.4vw,72px)]" at={4} />
        </div>
        <div className="max-w-[58ch] lg:text-right">
          <p className="text-[16px] text-ink">{s.title}</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">Run bounded queries against events that already exist in the loaded data. Every result is shown with its source, and the case is reassessed by the backend, not here.</p>
          <div className="mt-3 flex flex-wrap gap-2.5 lg:justify-end">
            <Chip title="Queries only retrieve existing events.">Retrieval only</Chip>
            {mock && <Chip dashed title="Outcomes are scripted by the in-app mock. They are not backend results or measurements.">Development fixture · scripted outcomes</Chip>}
          </div>
        </div>
      </header>

      {/* The central question: what the case cannot yet say. */}
      <section aria-labelledby="inv-q-h" className="mt-12 grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div>
          <h2 id="inv-q-h" className="t-micro text-ink">What the case cannot yet say</h2>
          <p className="mt-5 max-w-[34ch] text-[clamp(20px,2.3vw,34px)] font-light leading-[1.25] text-ink" data-testid="rationale">{c.verdict_rationale}</p>
          <p className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[13.5px] text-ink-muted">
            <VerdictLabel verdict={s.verdict} />
            <span>risk (heuristic) <span className="font-mono text-ink">{s.risk_score.value}</span> · {s.risk_score.band}</span>
            <span>confidence <span className="text-ink capitalize">{c.confidence.level}</span></span>
            <span>coverage <span className="font-mono text-ink">{Math.round(c.coverage.ratio * 100)}%</span></span>
          </p>
        </div>
        <div>
          <h3 className="t-label">Missing evidence</h3>
          {c.missing_evidence.length === 0 && c.coverage.missing.length === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-muted">The backend lists no missing evidence for this case.</p>
          ) : (
            <ul className="mt-3 space-y-3" data-testid="missing-list">
              {c.missing_evidence.map((m) => (
                <li key={m.missing_id} className="border-l border-dashed border-missing pl-4"><p className="text-[14px] text-ink">{m.telemetry}</p><p className="mt-0.5 text-[12.5px] text-ink-faint">{m.why_it_matters}</p></li>
              ))}
              {c.coverage.missing.filter((m) => !c.missing_evidence.some((x) => x.telemetry.toLowerCase() === m.toLowerCase())).map((m) => (
                <li key={m} className="border-l border-dashed border-missing pl-4 text-[14px] text-ink-muted">{m}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Instrument row: budget, stages, execution. */}
      <div className="mt-14 grid gap-x-14 gap-y-10 xl:grid-cols-[320px_minmax(0,1fr)]">
        <BudgetMeter budget={budget} executing={executing} />
        <div className="min-w-0 space-y-8">
          <StageRail stage={stage} failed={run.kind === "failed"} />
          <ExecutionStage
            candidate={selectedCand} request={preview} keyShown={selectedCand ? keys.current.peek(candidateId(selectedCand)) ?? null : null}
            run={run} budget={budget} timeoutSec={Math.round(timeoutMs / 1000)} mock={mock}
            onExecute={() => selectedCand && void execute(selectedCand)} onRetry={() => selectedCand && void execute(selectedCand)}
          />
        </div>
      </div>

      <section aria-labelledby="inv-plan-h" className="mt-16">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="inv-plan-h" className="t-micro text-ink">Evidence planner</h2>
          <p className="text-[12.5px] text-ink-faint">Proposals from the backend. A proposal is a plan, not evidence.</p>
        </div>
        {candidates.length === 0 ? (
          <div className="mt-6"><EmptyState title="No investigation candidates" detail="The backend proposed no further queries for this case, so there is nothing to run." /></div>
        ) : (
          <div className="mt-6 space-y-3">
            {candidates.map((x, i) => {
              const id = candidateId(x);
              const step = steps.find((st) => st.candidateId === id);
              return (
                <CandidateModule
                  key={`${id}#${i}`} candidate={x} index={i} status={statusOf(x)} selected={selected === id}
                  retrievedCount={step?.response.retrieved_events.length}
                  onSelect={() => { if (!executing) { setSelected(id); setRun({ kind: "idle" }); setPhase(null); } }}
                  onViewResult={step ? () => { setViewId(step.id); setPhase("assessed"); document.getElementById("inv-result")?.scrollIntoView({ block: "start" }); } : undefined}
                />
              );
            })}
          </div>
        )}
        {budget.exhausted && candidates.length > 0 && (
          <p role="status" className="mt-5 border-l-2 border-critical px-4 py-2 text-[13.5px] text-ink-muted" data-testid="exhausted-note">
            The investigation budget is exhausted. No further queries can be submitted for this case.
          </p>
        )}
      </section>

      <section id="inv-result" aria-labelledby="inv-led-h" className="mt-20 scroll-mt-24">
        <h2 id="inv-led-h" className="t-micro text-ink">Provenance ledger</h2>
        {steps.length === 0 ? (
          <p className="mt-4 text-[13.5px] text-ink-muted" data-testid="ledger-empty">No query has been run yet, so no evidence has been retrieved. Retrieved events will appear here with their source file, line and hash.</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Queries run in this session">
              {steps.map((st, i) => (
                <button key={st.id} type="button" onClick={() => { setViewId(st.id); setPhase("assessed"); }} aria-pressed={viewId === st.id}
                  className={`border px-3.5 py-2 font-mono text-[11.5px] tracking-wide ${viewId === st.id ? "border-verified bg-verified/10 text-verified" : "border-line-strong text-ink-muted hover:text-ink"}`}>
                  Q{i + 1} · {st.tool} · {st.response.retrieved_events.length} event{st.response.retrieved_events.length === 1 ? "" : "s"}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-ink-faint">Session record. The API exposes no history of past queries, so only queries run in this browser session are listed.</p>
            {view && cmp && (
              <div className="mt-8">
                <p className="text-[13.5px] text-ink-muted"><span className="t-label mr-2">Reason</span>{view.response.reason}</p>
                {view.response.retrieved_events.length === 0 ? (
                  <div className="mt-6" data-testid="no-matching"><EmptyState title="No matching evidence" detail="The query ran and found no events. It still used one query from the budget." /></div>
                ) : (
                  <div className="mt-4"><ProvenanceLedger caseId={caseId} events={view.response.retrieved_events} newIds={retrievedNew} updated={cmp.updated} /></div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="inv-ass-h" className="mt-20">
        <h2 id="inv-ass-h" className="t-micro mb-6 text-ink">Assessment</h2>
        {view && cmp ? (
          <AssessmentCompare cmp={cmp} retrieved={view.response.retrieved_events.length} />
        ) : (
          <p className="text-[13.5px] text-ink-muted">Run a query to see how the backend&rsquo;s assessment responds. Nothing is estimated before then.</p>
        )}
        {view && (
          <div className="mt-10 flex flex-wrap gap-4">
            <Link to={evidencePath(caseId)} className="border border-verified/50 px-5 py-3 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Open the case in the Evidence Room</Link>
            <Link to={`/app/counterfactual/${encodeURIComponent(caseId)}`} className="px-4 py-3 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">Challenge this case</Link>
          </div>
        )}
      </section>
    </div>
  );
}
