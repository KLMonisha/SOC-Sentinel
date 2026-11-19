import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/api/client";
import type { AdversarialRequest, AdversarialResponse, AdversarialScenarioId } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chamber, Comparison, Pips, TrialInspector } from "@/features/redteam/Results";
import { ScenarioSelector } from "@/features/redteam/ScenarioSelector";
import { buildRequest, MAX_TRIALS, MIN_TRIALS, parseTrials, reviewRun, SCENARIOS, trialNumbers } from "@/features/redteam/model";
import "@/features/redteam/redteam.css";
import { config } from "@/lib/config";

export const RED_TEAM_TIMEOUT_MS = 90_000;

type Run =
  | { kind: "idle" }
  | { kind: "running"; req: AdversarialRequest }
  | { kind: "error"; req: AdversarialRequest; message: string; code: string; status: number | null; requestId: string | null }
  | { kind: "done"; req: AdversarialRequest; res: AdversarialResponse };

/** Descriptive map of which dev fixture a trial count selects. Shown in mock mode only. */
const MOCK_HINT = [
  ["1–5, 10", "scenario default"], ["6", "empty result"], ["7", "backend error, then success on retry"], ["8", "partial results"], ["9", "invalid and missing citations"],
] as const;

export function RedTeamLab({ timeoutMs = RED_TEAM_TIMEOUT_MS }: { timeoutMs?: number }) {
  const [scenario, setScenario] = useState<AdversarialScenarioId | null>(null);
  const [trialsRaw, setTrialsRaw] = useState("3");
  const [tried, setTried] = useState(false);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [trial, setTrial] = useState<number | null>(null);
  const lock = useRef(false); // synchronous: a second click can land before React re-renders
  const ctrl = useRef<AbortController | null>(null);
  const mock = config.useMocks;

  useEffect(() => () => ctrl.current?.abort(), []);

  const parsed = parseTrials(trialsRaw);
  const trials = "value" in parsed ? parsed.value : NaN;
  const built = buildRequest(scenario, trials);
  const running = run.kind === "running";

  const start = useCallback(async () => {
    setTried(true);
    if (lock.current || !built.request) return;
    lock.current = true;
    const req = built.request;
    const c = new AbortController();
    ctrl.current = c;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.abort(); }, timeoutMs);
    setRun({ kind: "running", req });
    setTrial(null);
    try {
      const res = await api.runAdversarial(req, c.signal);
      setRun({ kind: "done", req, res });
      const first = trialNumbers(res)[0];
      setTrial(first ?? null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && !timedOut) { setRun({ kind: "idle" }); return; } // cancelled by the analyst
      const a = e instanceof ApiError ? e : null;
      setRun({
        kind: "error", req,
        code: timedOut ? "request_timeout" : a?.code ?? "unknown",
        status: a?.status ?? null,
        requestId: a?.requestId ?? null,
        message: timedOut ? `No answer within ${Math.round(timeoutMs / 1000)} seconds.` : a?.message ?? "The test could not be run.",
      });
    } finally {
      clearTimeout(timer);
      lock.current = false;
    }
  }, [built.request, timeoutMs]);

  const done = run.kind === "done" ? run : null;
  const review = useMemo(() => (done ? reviewRun(done.req, done.res) : null), [done]);
  const numbers = done ? trialNumbers(done.res) : [];
  const stale = !!done && (done.req.scenario_id !== scenario || done.req.trials !== trials);
  const trialError = tried && "error" in parsed ? parsed.error : null;
  const scenarioError = tried && !scenario ? "Choose a scenario." : null;

  return (
    <div className="mx-auto w-full max-w-[1760px] px-6 pb-28 pt-8 sm:px-10 lg:px-14">
      <header className="flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
        <div>
          <p className="t-label mb-4">Adversarial testing</p>
          <DisplayTitle lines={["Red team", "lab"]} size="text-[clamp(30px,5.4vw,88px)]" at={4} />
        </div>
        <div className="max-w-[60ch] lg:text-right">
          <p className="text-[16px] text-ink">Can text planted in a log field steer the investigation?</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">Each test sends an inert payload through a baseline and a hardened pipeline and returns what each one did, trial by trial. Payloads are test data: nothing is attacked, blocked or executed.</p>
          <div className="mt-3 flex flex-wrap gap-2.5 lg:justify-end">
            <Chip title="Payloads are fixed strings that are only displayed.">Inert payloads</Chip>
            {mock && <Chip dashed title="Results are scripted by the in-app mock. They are not backend results or benchmark measurements.">Development fixture · not measured</Chip>}
          </div>
        </div>
      </header>

      <section aria-labelledby="rt-surface-h" className="mt-14">
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="rt-surface-h" className="t-micro text-ink">1 · Attack surface</h2>
          <p className="text-[12.5px] text-ink-faint">Exactly the three scenarios the API supports.</p>
        </div>
        <ScenarioSelector value={scenario} onChange={(id) => setScenario(id)} disabled={running} />
        {scenarioError && <p role="alert" className="mt-3 text-[12.5px] text-critical">{scenarioError}</p>}
      </section>

      <section aria-labelledby="rt-config-h" className="mt-16 grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <h2 id="rt-config-h" className="t-micro text-ink">2 · Trial configuration</h2>
          <form className="mt-6" noValidate onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <label htmlFor="rt-trials" className="t-label">Trials ({MIN_TRIALS}–{MAX_TRIALS})</label>
            <div className="mt-2 flex items-stretch gap-2">
              <button type="button" aria-label="Fewer trials" disabled={running || !("value" in parsed) || parsed.value <= MIN_TRIALS} onClick={() => "value" in parsed && setTrialsRaw(String(parsed.value - 1))} className="w-11 border border-line-strong text-[18px] text-ink-muted hover:text-ink disabled:opacity-40">−</button>
              <input
                id="rt-trials" inputMode="numeric" autoComplete="off" value={trialsRaw} onChange={(e) => setTrialsRaw(e.target.value)} disabled={running}
                aria-invalid={!!trialError} aria-describedby={trialError ? "rt-trials-err" : "rt-trials-help"}
                className="w-24 border border-line-strong bg-transparent px-3 py-2 text-center font-mono text-[16px] outline-none focus:border-verified disabled:opacity-60"
              />
              <button type="button" aria-label="More trials" disabled={running || !("value" in parsed) || parsed.value >= MAX_TRIALS} onClick={() => "value" in parsed && setTrialsRaw(String(parsed.value + 1))} className="w-11 border border-line-strong text-[18px] text-ink-muted hover:text-ink disabled:opacity-40">+</button>
            </div>
            {trialError ? <p id="rt-trials-err" role="alert" className="mt-2 text-[12.5px] text-critical">{trialError}</p> : <p id="rt-trials-help" className="mt-2 text-[12px] text-ink-faint">The backend caps a run at {MAX_TRIALS} trials.</p>}

            <p className="t-label mt-8">Review: exactly what will be sent</p>
            <pre className="mt-2 overflow-x-auto border-l border-line-strong bg-void/60 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink" data-testid="request-preview">
              {built.request ? `POST /api/adversarial/run\n${JSON.stringify(built.request, null, 2)}` : `POST /api/adversarial/run\n— incomplete: ${built.problems.join(" ")}`}
            </pre>
            <p className="mt-2 text-[12px] text-ink-faint">This request has no idempotency key; every start is an independent run.</p>

            <button type="submit" disabled={running}
              className="brk mt-6 w-full border border-verified/60 bg-verified/10 px-6 py-4 text-[11.5px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/20 disabled:cursor-wait disabled:opacity-60 sm:w-auto">
              {running ? "Test running…" : done || run.kind === "error" ? "Run the test again" : "Start test"}
            </button>
            {running && <button type="button" onClick={() => ctrl.current?.abort()} className="ml-0 mt-3 block px-1 py-2 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink sm:ml-4 sm:mt-0 sm:inline-block">Cancel</button>}
          </form>
        </div>

        <div>
          <h2 className="t-micro text-ink">Trust boundary</h2>
          <div className="mt-6 space-y-2 text-[13.5px] leading-relaxed text-ink-muted">
            <p className="rt-trusted px-4 py-3"><span className="text-verified">Trusted:</span> system instructions and recorded analyst decisions.</p>
            <p className="rt-hostile px-4 py-3"><span className="text-suspicious">Attacker-controlled:</span> every raw log field, including the payload under test. It is data, never instruction, and it is always drawn in this hatched style.</p>
          </div>
          {mock && (
            <details className="mt-6 text-[12.5px] text-ink-muted">
              <summary className="cursor-pointer text-ink">Development fixture map (mock mode only)</summary>
              <p className="mt-2 max-w-[60ch] text-ink-faint">The request carries only the scenario and the trial count, so the mock picks its scripted outcome from the trial count. These patterns are hand-written, not measurements.</p>
              <ul className="mt-2 space-y-1 font-mono">{MOCK_HINT.map(([t, b]) => <li key={t}>trials {t}: {b}</li>)}</ul>
            </details>
          )}
        </div>
      </section>

      <section aria-labelledby="rt-stage-h" className="mt-20">
        <h2 id="rt-stage-h" className="t-micro mb-6 text-ink">3 · Experiment stage</h2>
        {run.kind === "idle" && (
          <p className="mb-5 max-w-[60ch] text-[13.5px] text-ink-muted" data-testid="idle-note">No test has been run. Choose a scenario and start one; results appear here exactly as the backend returns them.</p>
        )}
        {running && (
          <p role="status" className="mb-5 max-w-[68ch] text-[13.5px] text-ink-muted" data-testid="running-note">
            Running {run.req.trials} trial{run.req.trials === 1 ? "" : "s"} of {SCENARIOS[run.req.scenario_id].name.toLowerCase()}. The backend returns one final response, so no progress is available and none is shown. Gives up after {Math.round(timeoutMs / 1000)} s.
            {mock && <span className="text-ink-faint"> (Development fixture.)</span>}
          </p>
        )}
        {run.kind === "error" && (
          <div role="alert" className="mb-5 max-w-[72ch] border-l-2 border-critical bg-critical/5 px-5 py-4 text-[13.5px]" data-testid="run-error" data-code={run.code}>
            <p className="text-critical">{run.code === "request_timeout" ? "The test timed out." : run.code === "network_error" ? "The backend could not be reached." : "The test could not be completed."}</p>
            <p className="mt-1 text-ink-muted">{run.message}{run.status !== null && <span className="ml-2 font-mono text-xs text-ink-faint">HTTP {run.status}</span>}{run.requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {run.requestId}</span>}</p>
            <p className="mt-2 text-ink-faint">No results were recorded for this attempt. Starting again sends a new, independent request.</p>
          </div>
        )}
        {stale && done && (
          <p role="note" className="mb-5 text-[13px] text-suspicious" data-testid="stale-note">The results below are from the earlier run ({SCENARIOS[done.req.scenario_id].name}, {done.req.trials} trial{done.req.trials === 1 ? "" : "s"}), not from the current configuration.</p>
        )}
        <Chamber running={running} res={done?.res ?? null} review={review} />
        {done && review?.empty && (
          <div className="mt-6" data-testid="empty-result"><EmptyState title="Empty result" detail="The backend ran the test but returned no trial records for either pipeline, so there is nothing to compare. No rate is shown." /></div>
        )}
        {done && review?.partial && (
          <p role="note" className="mt-5 text-[13.5px] text-suspicious" data-testid="partial-note">
            Partial results: {done.req.trials} trials were requested, but baseline returned {review.baseline.returned} and hardened returned {review.hardened.returned} trial records. Trials that were not returned are shown as missing, not as passed or failed.
          </p>
        )}
      </section>

      {done && review && !review.empty && (
        <>
          <section aria-labelledby="rt-cmp-h" className="mt-20">
            <h2 id="rt-cmp-h" className="t-micro mb-6 text-ink">4 · Baseline versus hardened</h2>
            <Comparison res={done.res} review={review} requested={done.req.trials} />
          </section>

          <section aria-labelledby="rt-insp-h" className="mt-20">
            <h2 id="rt-insp-h" className="t-micro mb-4 text-ink">5 · Trial inspector</h2>
            <p className="mb-4 text-[12.5px] text-ink-faint">Select a trial. ✕ injection succeeded · ✓ injection resisted · – not returned.</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <div><p className="t-label mb-2">Baseline</p><Pips result={done.res.baseline} numbers={numbers} selected={trial} onSelect={setTrial} label="Baseline trials" /></div>
              <div><p className="t-label mb-2">Hardened</p><Pips result={done.res.hardened} numbers={numbers} selected={trial} onSelect={setTrial} label="Hardened trials" /></div>
            </div>
            {trial !== null && <div className="mt-8 border-t border-line pt-8" aria-live="polite"><h3 className="t-micro mb-6 text-ink">Trial {trial}</h3><TrialInspector res={done.res} review={review} trial={trial} /></div>}
          </section>
        </>
      )}
    </div>
  );
}
