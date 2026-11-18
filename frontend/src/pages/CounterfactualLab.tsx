import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Check, TriangleAlert } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseDetail, CounterfactualResponse } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Surface } from "@/components/ui/Surface";
import { Connectors } from "@/features/counterfactual/Connectors";
import { EventSpine } from "@/features/counterfactual/EventSpine";
import { BranchPlaceholder, OutcomeCard, type Mark } from "@/features/counterfactual/OutcomeCard";
import { ComparisonTable, ResultDetails } from "@/features/counterfactual/ResultDetails";
import { compare, findingsCiting, storedCaseUnchanged } from "@/features/counterfactual/diff";
import { orderEvents } from "@/features/evidence/model/graphModel";
import { evidencePath } from "@/features/report/citations";
import { config } from "@/lib/config";
import { VERDICT_LABEL } from "@/lib/format";

type Load = { kind: "loading" } | { kind: "error"; error: ApiError | Error } | { kind: "ready"; data: CaseDetail };
type Verify = "pending" | "unchanged" | "changed" | "failed";
type Run =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; res: CounterfactualResponse; excluded: string; verify: Verify }
  | { kind: "error"; message: string; requestId: string | null; code: string | null };

export function validateRun(eventId: string | null, reason: string): { event?: string; reason?: string } {
  return {
    ...(eventId ? {} : { event: "Select the event to exclude." }),
    ...(reason.trim() ? {} : { reason: "A reason is required." }),
  };
}

export function CounterfactualLab() {
  const { caseId = "" } = useParams();
  const [params] = useSearchParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(params.get("event"));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const inFlight = useRef<AbortController | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const originalEl = useRef<HTMLElement>(null);
  const branchEl = useRef<HTMLElement>(null);

  const fetchCase = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoad({ kind: "ready", data: await api.getCase(caseId, signal) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setLoad({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading the case.") });
    }
  }, [caseId]);

  useEffect(() => {
    setLoad({ kind: "loading" });
    setRun({ kind: "idle" });
    const ctrl = new AbortController();
    void fetchCase(ctrl.signal);
    return () => { ctrl.abort(); inFlight.current?.abort(); };
  }, [fetchCase]);

  const stored = load.kind === "ready" ? load.data : null;
  const events = useMemo(() => (stored ? orderEvents(stored.events) : []), [stored]);
  const eventIds = useMemo(() => new Set(events.map((e) => e.event_id)), [events]);
  const citedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of stored?.findings ?? []) for (const id of f.event_ids) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [stored]);
  const preselectUnknown = params.get("event") && stored && !eventIds.has(params.get("event")!) ? params.get("event") : null;
  const validSelected = selected && eventIds.has(selected) ? selected : null;
  const problems = validateRun(validSelected, reason);

  const choose = (id: string) => {
    setSelected(id);
    setRun({ kind: "idle" }); // a result belongs to the event it was run for
  };

  async function execute() {
    setTried(true);
    if (!stored || problems.event || problems.reason || run.kind === "running") return;
    const excluded = validSelected!;
    const ctrl = new AbortController();
    inFlight.current?.abort();
    inFlight.current = ctrl;
    setRun({ kind: "running" });
    try {
      const res = await api.counterfactual(caseId, { overrides: [{ type: "exclude_event", event_id: excluded, reason: reason.trim() }] }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setRun({ kind: "done", res, excluded, verify: "pending" });
      // Integrity check: re-read the stored case and confirm the counterfactual did not change it.
      try {
        const after = await api.getCase(caseId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setRun((r) => (r.kind === "done" && r.res === res ? { ...r, verify: storedCaseUnchanged(stored, after) ? "unchanged" : "changed" } : r));
      } catch {
        setRun((r) => (r.kind === "done" && r.res === res ? { ...r, verify: "failed" } : r));
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const apiErr = e instanceof ApiError ? e : null;
      setRun({ kind: "error", message: apiErr?.message ?? "The counterfactual could not be run.", requestId: apiErr?.requestId ?? null, code: apiErr?.code ?? null });
    }
  }

  if (load.kind === "loading") return <p role="status" className="px-6 py-10 text-[13px] text-ink-muted sm:px-14">Loading case…</p>;
  if (load.kind === "error") {
    const requestId = "requestId" in load.error ? load.error.requestId : null;
    return (
      <div role="alert" className="mx-auto mt-12 max-w-xl border border-critical/40 p-5 text-[13.5px]">
        <p className="text-critical">Could not open case {caseId}.</p>
        <p className="mt-1 text-ink-muted">{load.error.message}{requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {requestId}</span>}</p>
        <div className="mt-4 flex gap-3">
          <button onClick={() => { setLoad({ kind: "loading" }); void fetchCase(); }} className="border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Retry</button>
          <Link to="/app/counterfactual" className="px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">Choose another case</Link>
        </div>
      </div>
    );
  }

  const c = load.data;
  const s = c.summary;
  const done = run.kind === "done" ? run : null;
  const cmp = done ? compare(c, done.res) : null;
  const citing = new Set(validSelected ? findingsCiting(c, validSelected).map((f) => f.finding_id) : []);
  const originalMarks = new Map<string, Mark>();
  const branchMarks = new Map<string, Mark>();
  if (done) {
    done.res.removed.forEach((r) => originalMarks.set(r.finding.finding_id, "removed"));
    done.res.changed.forEach((x) => { originalMarks.set(x.before.finding_id, "changed"); branchMarks.set(x.after.finding_id, "changed"); });
    done.res.added.forEach((a) => branchMarks.set(a.finding.finding_id, "added"));
  }
  const state: "idle" | "running" | "done" = run.kind === "running" ? "running" : done ? "done" : "idle";

  return (
    <div className="mx-auto w-full max-w-[1760px] px-6 pb-24 pt-8 sm:px-10 lg:px-14">
      <Link to={evidencePath(s.case_id, validSelected ?? undefined)} className="inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Evidence Room
      </Link>

      <header className="mt-6 flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
        <div>
          <p className="t-label mb-4">Counterfactual lab · {s.case_id}</p>
          <DisplayTitle lines={["What would", "change my mind?"]} size="text-[clamp(24px,3.8vw,58px)]" at={4} />
        </div>
        <div className="max-w-[58ch] lg:text-right">
          <p className="text-[16px] text-ink">{s.title}</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
            Remove one piece of evidence and the backend reruns detection, correlation and scoring on what is left. The stored case is never changed.
          </p>
          <div className="mt-3 flex flex-wrap gap-2.5 lg:justify-end">
            <Chip title="This is the only operation the backend supports.">Operation: exclude event</Chip>
            {config.useMocks && <Chip dashed title="Recomputation is produced by the in-app mock, a simplified stand-in.">Development fixture · not a real rerun</Chip>}
          </div>
        </div>
      </header>

      {c.events.length === 0 ? (
        <div className="mt-12"><EmptyState title="No source events" detail="This case has no stored events, so there is nothing to exclude." /></div>
      ) : (
        <>
          {done && cmp && (
            <div role="status" className="mt-10">
              <Surface level="raised" brackets className="px-7 py-5">
                <p className="t-display text-[clamp(16px,1.9vw,26px)] text-ink">
                  {cmp.verdictChanged
                    ? <>Verdict changed: <span className="text-ink-muted">{VERDICT_LABEL[done.res.original.verdict]}</span> → {VERDICT_LABEL[done.res.recomputed.verdict]}</>
                    : <>Verdict unchanged: {VERDICT_LABEL[done.res.recomputed.verdict]}</>}
                </p>
                <p className="mt-3 text-[14px] text-ink-muted">
                  Heuristic risk {done.res.original.risk_score.value} → {done.res.recomputed.risk_score.value}
                  {done.res.score_delta !== 0 ? ` (${done.res.score_delta > 0 ? "+" : "−"}${Math.abs(done.res.score_delta)})` : " (no change)"}
                  {cmp.confidenceChanged ? ` · confidence ${done.res.original.confidence.level} → ${done.res.recomputed.confidence.level}` : ""}
                  {!cmp.verdictChanged && " · An unchanged verdict is a valid result: this evidence was not what the conclusion depended on."}
                </p>
              </Surface>
              {(!cmp.riskDeltaMatchesReported || cmp.originalMismatches.length > 0) && (
                <ul className="mt-3 space-y-1.5 text-[13px] text-suspicious">
                  {!cmp.riskDeltaMatchesReported && <li className="flex gap-2"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />The reported score change ({done.res.score_delta}) does not equal the difference between the returned scores ({cmp.riskDelta}). Showing the backend's values unmodified.</li>}
                  {cmp.originalMismatches.length > 0 && <li className="flex gap-2"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />The response's &ldquo;original&rdquo; outcome differs from the stored case ({cmp.originalMismatches.join("; ")}).</li>}
                </ul>
              )}
            </div>
          )}

          <div ref={stage} className="relative mt-10 grid grid-cols-[minmax(0,1fr)] items-start gap-x-20 gap-y-8 xl:grid-cols-[minmax(0,1fr)_400px_minmax(0,1fr)]">
            <Connectors stage={stage} original={originalEl} recomputed={branchEl} spineNode={validSelected} state={state} />

            <OutcomeCard
              kind="original" innerRef={originalEl} verdict={c.summary.verdict} risk={c.summary.risk_score} confidence={c.confidence}
              coverage={c.coverage} findings={c.findings} marks={originalMarks} citing={citing} selectedEventId={validSelected}
            />

            <section aria-labelledby="chain-h" className="relative z-[1]">
              <h2 id="chain-h" className="t-micro text-ink">Event chain</h2>
              <p className="mt-1.5 text-[12.5px] text-ink-faint">Pick the event to exclude. “Cited” counts the stored findings that rely on it.</p>
              <div className="mt-4"><EventSpine events={events} selected={validSelected} onSelect={choose} citedBy={citedBy} disabled={run.kind === "running"} /></div>
              {tried && problems.event && <p role="alert" className="mt-2 text-[12.5px] text-critical">{problems.event}</p>}
              {preselectUnknown && <p role="alert" className="mt-2 text-[12.5px] text-suspicious">The linked event {preselectUnknown} is not part of this case, so nothing is selected.</p>}

              <form className="mt-6" onSubmit={(e) => { e.preventDefault(); void execute(); }} noValidate>
                <label htmlFor="cf-reason" className="t-label">Reason <span className="text-critical" aria-hidden>*</span></label>
                <textarea
                  id="cf-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required disabled={run.kind === "running"}
                  aria-invalid={tried && !!problems.reason} aria-describedby={tried && problems.reason ? "cf-reason-err" : undefined}
                  placeholder="Why you are challenging this evidence"
                  className="mt-2 w-full resize-y border border-line-strong bg-transparent px-3 py-2 text-[13.5px] outline-none placeholder:text-ink-faint focus:border-verified disabled:opacity-60"
                />
                {tried && problems.reason && <p id="cf-reason-err" role="alert" className="mt-1.5 text-[12.5px] text-critical">{problems.reason}</p>}
                <button type="submit" disabled={run.kind === "running"}
                  className="brk mt-4 w-full border border-verified/60 bg-verified/10 px-5 py-3.5 text-[11.5px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/20 disabled:cursor-wait disabled:opacity-60">
                  {run.kind === "running" ? "Recomputing…" : "Recompute without this event"}
                </button>
                <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
                  Only exclusion is supported. Verified-VPN, invalidated-IOC and maintenance overrides are not offered until the backend can verify and recompute them.
                </p>
              </form>

              {run.kind === "error" && (
                <div role="alert" className="mt-5 border border-critical/40 p-4 text-[13px]">
                  <p className="text-critical">{run.code === "UNSUPPORTED_OVERRIDE" ? "The backend does not support this override." : run.code === "EVENT_NOT_FOUND" ? "The backend does not recognise that event for this case." : "The counterfactual could not be run."}</p>
                  <p className="mt-1 text-ink-muted">{run.message}{run.requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {run.requestId}</span>}</p>
                  <p className="mt-2 text-ink-faint">Nothing was changed. You can adjust the selection and try again.</p>
                </div>
              )}
            </section>

            {done ? (
              <OutcomeCard
                kind="recomputed" innerRef={branchEl} verdict={done.res.recomputed.verdict} risk={done.res.recomputed.risk_score}
                confidence={done.res.recomputed.confidence} coverage={null} findings={done.res.recomputed.findings}
                marks={branchMarks} riskDelta={done.res.score_delta} ghosts={done.res.removed.map((r) => r.finding)}
              />
            ) : (
              <BranchPlaceholder innerRef={branchEl} state={run.kind === "running" ? "running" : "idle"} />
            )}
          </div>

          {done && cmp && (
            <div className="mt-16 space-y-14">
              <section aria-labelledby="chg-h">
                <h2 id="chg-h" className="t-micro mb-6 text-ink">What changed</h2>
                <ResultDetails stored={c} res={done.res} cmp={cmp} excludedIds={[done.excluded]} />
              </section>

              <section aria-labelledby="tbl-h">
                <h2 id="tbl-h" className="t-micro mb-4 text-ink">Structured comparison</h2>
                <ComparisonTable res={done.res} storedCoverage={c.coverage.ratio} cmp={cmp} />
              </section>

              <section aria-labelledby="int-h">
                <h2 id="int-h" className="t-micro mb-3 text-ink">Integrity</h2>
                <p role="status" className={`flex items-start gap-2.5 text-[13.5px] ${done.verify === "changed" ? "text-critical" : "text-ink-muted"}`}>
                  {done.verify === "unchanged" && <><Check size={15} aria-hidden className="mt-0.5 shrink-0 text-verified" /> The stored case was re-read after the run and is unchanged. The counterfactual did not modify it.</>}
                  {done.verify === "pending" && "Re-reading the stored case to confirm it is unchanged…"}
                  {done.verify === "changed" && <><TriangleAlert size={15} aria-hidden className="mt-0.5 shrink-0" /> The stored case differs from its state before the run. A counterfactual must never modify it; report this to the backend owner.</>}
                  {done.verify === "failed" && "The stored case could not be re-read, so its integrity after the run is unverified."}
                </p>
                <p className="mt-2 text-[12.5px] text-ink-faint">The recomputed branch is hypothetical and is not saved. Reason recorded with this request: “{reason.trim()}”.</p>
              </section>

              <div className="flex flex-wrap gap-4">
                <button type="button" onClick={() => setRun({ kind: "idle" })} className="border border-verified/50 px-5 py-3 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Try another event</button>
                <Link to={evidencePath(s.case_id, done.excluded)} className="inline-flex items-center gap-2 px-4 py-3 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
                  Back to the original investigation <ArrowUpRight size={13} aria-hidden />
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
