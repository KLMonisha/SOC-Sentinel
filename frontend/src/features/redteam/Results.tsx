import { Check, ShieldAlert, TriangleAlert, X } from "lucide-react";
import type { AdversarialResponse, PipelineResult } from "@/api/types";
import { outcomeOf, SCENARIOS, trialNumbers, type CitationStatus, type PipelineSummary, type RunReview, type TrialOutcome } from "./model";

const OUTCOME_LABEL: Record<TrialOutcome, string> = {
  injection_succeeded: "Injection succeeded",
  injection_resisted: "Injection resisted",
  not_returned: "Trial not returned",
};
const PIP_SYMBOL: Record<TrialOutcome, string> = { injection_succeeded: "✕", injection_resisted: "✓", not_returned: "–" };

export function Pips({ result, numbers, selected, onSelect, label }: { result: PipelineResult; numbers: number[]; selected: number | null; onSelect?: (n: number) => void; label: string }) {
  const by = new Map(result.outputs.map((o) => [o.trial, o]));
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {numbers.map((n, i) => {
        const o = outcomeOf(by.get(n));
        const content = <span className="rt-pip" data-outcome={o} style={{ ["--i" as string]: i }} aria-hidden>{PIP_SYMBOL[o]}</span>;
        return (
          <li key={n}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(n)} aria-pressed={selected === n} aria-label={`Trial ${n}: ${OUTCOME_LABEL[o]}`} className={`p-0.5 ${selected === n ? "outline outline-2 outline-focus" : ""}`}>{content}</button>
            ) : (
              <span role="img" aria-label={`Trial ${n}: ${OUTCOME_LABEL[o]}`}>{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const CITE_TEXT: Record<CitationStatus, { label: string; tone: string }> = {
  all_verified: { label: "All returned citations verified", tone: "text-verified" },
  some_rejected: { label: "Some citations were rejected", tone: "text-critical" },
  none_checked: { label: "No citations were checked or returned", tone: "text-suspicious" },
  inconsistent: { label: "Citation counts are inconsistent", tone: "text-suspicious" },
};

export function CitationIntegrity({ s }: { s: PipelineSummary }) {
  const t = CITE_TEXT[s.citation.status];
  const Icon = s.citation.status === "all_verified" ? Check : s.citation.status === "some_rejected" ? ShieldAlert : TriangleAlert;
  return (
    <div data-testid="citation" data-status={s.citation.status}>
      <p className={`flex items-start gap-2 text-[13.5px] ${t.tone}`}><Icon size={14} aria-hidden className="mt-0.5 shrink-0" />{t.label}</p>
      <p className="mt-1 font-mono text-[12.5px] text-ink-muted">{s.citation.verified} verified · {s.citation.rejected} rejected · {s.citation.total} total</p>
      {s.citation.status === "none_checked" && <p className="mt-1 text-[12px] text-ink-faint">Absence of citations is not evidence of validity.</p>}
    </div>
  );
}

function Lane({ name, kind, running, s, result, numbers }: { name: string; kind: "baseline" | "hardened"; running: boolean; s: PipelineSummary | null; result: PipelineResult | null; numbers: number[] }) {
  return (
    <section aria-label={`${name} pipeline`} className={`rt-lane ${kind === "hardened" ? "mat-lit brk" : "mat-raised"} relative px-6 py-6`} data-running={running} data-testid={`lane-${kind}`}>
      {kind === "hardened" && <><i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden /><i className="brk-c" aria-hidden /></>}
      <h3 className="t-micro text-ink">{name}</h3>
      {running && <p className="mt-5 text-[13.5px] text-ink-muted">Waiting for the backend.</p>}
      {!running && !s && <p className="mt-5 text-[13.5px] text-ink-faint">No result yet.</p>}
      {!running && s && result && (
        <>
          <p className="t-display mt-5 text-[clamp(20px,2vw,30px)] tabular-nums text-ink" data-testid={`${kind}-headline`}>
            {s.returned === 0 ? "No trial records" : <>{s.successes} <span className="text-ink-faint">of</span> {s.returned}</>}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-muted">{s.returned === 0 ? "The backend returned no trial records." : "trials where the injection succeeded"}</p>
          <div className="mt-5"><Pips result={result} numbers={numbers} selected={null} label={`${name} trial outcomes`} /></div>
        </>
      )}
    </section>
  );
}

/** The experiment stage. While running there is no progress to report, so none is drawn. */
export function Chamber({ running, res, review }: { running: boolean; res: AdversarialResponse | null; review: RunReview | null }) {
  const numbers = res ? trialNumbers(res) : [];
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="chamber" data-state={running ? "running" : res ? "done" : "idle"}>
      <Lane name="Baseline" kind="baseline" running={running} s={review?.baseline ?? null} result={res?.baseline ?? null} numbers={numbers} />
      <Lane name="Hardened" kind="hardened" running={running} s={review?.hardened ?? null} result={res?.hardened ?? null} numbers={numbers} />
    </div>
  );
}

const pct = (n: number | null) => (n === null ? "n/a" : `${n}%`);

export function Comparison({ res, review, requested }: { res: AdversarialResponse; review: RunReview; requested: number }) {
  const info = SCENARIOS[res.scenario.scenario_id];
  const rows: { label: string; cell: (s: PipelineSummary, kind: "baseline" | "hardened") => React.ReactNode }[] = [
    { label: "Trials", cell: (s) => <span data-testid="cmp-trials">{s.returned} returned · {s.reportedTrials} reported · {requested} requested</span> },
    { label: "Injection succeeded", cell: (s) => <span data-testid="cmp-success">{s.returned ? `${s.successes} of ${s.returned} (${pct(s.rate)})` : "n/a: no trial records"}</span> },
    { label: "Injection resisted", cell: (s) => <span data-testid="cmp-resisted">{s.returned ? `${s.failures} of ${s.returned}` : "n/a"}</span> },
    { label: "Observed trust-boundary violations", cell: (s) => <span data-testid="cmp-violations">{s.violatedTrials.length ? `trial${s.violatedTrials.length > 1 ? "s" : ""} ${s.violatedTrials.join(", ")}` : s.returned ? "none in the returned records" : "n/a"}</span> },
    { label: "Citation check", cell: (s) => <CitationIntegrity s={s} /> },
  ];
  return (
    <div data-testid="comparison">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
          <caption className="sr-only">Baseline versus hardened, from the returned trial records</caption>
          <thead>
            <tr className="border-b border-line-strong">
              <th scope="col" className="t-label py-3 pr-6 font-normal">Measured · from returned records</th>
              <th scope="col" className="t-micro py-3 pr-6 text-ink">Baseline</th>
              <th scope="col" className="t-micro py-3 text-ink">Hardened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-line align-top">
                <th scope="row" className="py-4 pr-6 text-[13px] font-normal text-ink-muted">{r.label}</th>
                <td className="py-4 pr-6 text-ink">{r.cell(review.baseline, "baseline")}</td>
                <td className="py-4 text-ink">{r.cell(review.hardened, "hardened")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-5 text-[14px] text-ink" data-testid="rate-delta">
        {review.rateDelta === null
          ? "A change in success rate cannot be computed because one pipeline returned no trial records."
          : review.rateDelta === 0
            ? "Hardened and baseline injection-success rates are the same in these returned records."
            : `Injection-success rate in the returned records: hardened ${review.rateDelta < 0 ? "lower" : "higher"} by ${Math.abs(review.rateDelta)} percentage points.`}
      </p>
      <p className="mt-1 max-w-[70ch] text-[12.5px] text-ink-faint">Rates are computed here from the trial records the backend returned. They describe this run only, not how either pipeline performs in general.</p>

      <div className="mt-8 grid gap-6 border-l border-line-strong pl-5 lg:grid-cols-2">
        <div>
          <p className="t-label">Descriptive · not measured</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted"><span className="text-ink">Expected defence for {info.name.toLowerCase()}:</span> {info.defence}</p>
        </div>
        <div>
          <p className="t-label">Test settings reported by the backend</p>
          <p className="mt-2 font-mono text-[12.5px] text-ink-muted" data-testid="settings">{Object.entries(res.settings).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</p>
        </div>
      </div>

      {review.notes.length > 0 && (
        <ul className="mt-6 space-y-1.5 text-[13px] text-suspicious" data-testid="review-notes" aria-label="Response consistency notes">
          {review.notes.map((n) => <li key={n} className="flex gap-2"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function Detail({ title, outcome, output, citation }: { title: string; outcome: TrialOutcome; output: string | null; citation: PipelineSummary }) {
  const Icon = outcome === "injection_succeeded" ? X : outcome === "injection_resisted" ? Check : TriangleAlert;
  const tone = outcome === "injection_succeeded" ? "text-critical" : outcome === "injection_resisted" ? "text-verified" : "text-suspicious";
  return (
    <section aria-label={`${title} trial result`} className="min-w-0" data-testid={`inspect-${title.toLowerCase()}`}>
      <h4 className="t-micro text-ink">{title}</h4>
      <p className={`mt-3 flex items-center gap-2 text-[14px] ${tone}`} data-testid={`outcome-${title.toLowerCase()}`}><Icon size={14} aria-hidden />{OUTCOME_LABEL[outcome]}</p>
      <p className="t-label mt-4">Observed agent behaviour (output returned by the backend)</p>
      {output === null ? (
        <p className="mt-2 text-[13px] text-suspicious">This trial was not returned for this pipeline, so nothing is shown.</p>
      ) : (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border-l border-line-strong bg-void/60 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink" data-testid={`output-${title.toLowerCase()}`}>{output}</pre>
      )}
      <p className="t-label mt-4">Citation verification</p>
      <p className="mt-1.5 text-[13px] text-ink-muted" data-testid={`trialcite-${title.toLowerCase()}`}>
        Not returned per trial. For the whole {title.toLowerCase()} run: {citation.citation.verified} verified, {citation.citation.rejected} rejected, {citation.citation.total} total.
      </p>
    </section>
  );
}

/** Inspect one trial across both pipelines. Every payload and output is rendered as inert text. */
export function TrialInspector({ res, review, trial }: { res: AdversarialResponse; review: RunReview; trial: number }) {
  const b = res.baseline.outputs.find((o) => o.trial === trial);
  const h = res.hardened.outputs.find((o) => o.trial === trial);
  const info = SCENARIOS[res.scenario.scenario_id];
  return (
    <div data-testid="inspector" data-trial={trial}>
      <dl className="grid gap-x-12 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div><dt className="t-label">Scenario</dt><dd className="mt-1.5 text-[14px] text-ink" data-testid="insp-scenario">{res.scenario.title} <span className="font-mono text-[12px] text-ink-faint">({res.scenario.scenario_id})</span></dd></div>
        <div><dt className="t-label">Injection surface (field)</dt><dd className="mt-1.5 font-mono text-[13px] text-ink" data-testid="insp-field">{res.scenario.field}</dd></div>
        <div className="lg:col-span-2">
          <dt className="t-label flex flex-wrap items-center gap-3"><span>Attacker-controlled payload</span><span className="rt-hostile px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-suspicious">Inert test data · untrusted</span></dt>
          <dd><pre className="rt-hostile mt-2 overflow-x-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink" data-testid="insp-payload">{res.scenario.untrusted_payload}</pre></dd>
        </div>
        <div className="lg:col-span-2"><dt className="t-label">Expected behaviour · descriptive, not measured</dt><dd className="mt-1.5 max-w-[72ch] text-[13.5px] leading-relaxed text-ink-muted" data-testid="insp-expected">{info.defence}</dd></div>
      </dl>
      <div className="mt-8 grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <Detail title="Baseline" outcome={outcomeOf(b)} output={b?.output ?? null} citation={review.baseline} />
        <Detail title="Hardened" outcome={outcomeOf(h)} output={h?.output ?? null} citation={review.hardened} />
      </div>
      <p className="mt-6 max-w-[72ch] text-[12.5px] text-ink-faint">Supporting evidence: the output text above is the only trial-level evidence the backend returns. It does not say why a trial was or was not marked as an injection success.</p>
    </div>
  );
}

