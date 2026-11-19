import { TriangleAlert } from "lucide-react";
import type { Finding, Verdict } from "@/api/types";
import { VERDICT_LABEL } from "@/lib/format";
import { outcomeOf, type AssessmentComparison } from "./model";

const TONE: Record<Verdict, string> = {
  likely_malicious: "text-critical",
  needs_investigation: "text-suspicious",
  likely_benign: "text-verified",
  insufficient_evidence: "text-missing",
};
const pctOf = (r: number) => `${Math.round(r * 100)}%`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

function FindingLine({ f, tag }: { f: Finding; tag: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px]">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-verified">{tag}</span>
      <span className="text-ink">{f.title}</span>
      <span className="text-ink-faint">{f.stance} · weight {f.weight > 0 ? "+" : ""}{f.weight}</span>
    </li>
  );
}

/** Before/after, using only what the backend returned. An unchanged verdict is stated plainly, not hidden. */
export function AssessmentCompare({ cmp, retrieved }: { cmp: AssessmentComparison; retrieved: number }) {
  const outcome = outcomeOf(cmp, retrieved);
  if (!cmp.after || !cmp.updated) {
    return (
      <div role="status" className="border-l-2 border-suspicious px-5 py-4 text-[14px] text-ink-muted" data-testid="no-assessment">
        <p className="text-suspicious">No updated assessment was returned.</p>
        <p className="mt-1">The backend answered without a revised case, so the verdict, risk and confidence shown elsewhere are the earlier values. The console does not estimate a new one.</p>
        <p className="mt-2 font-mono text-[12px] text-ink-faint">Earlier values: {VERDICT_LABEL[cmp.before.verdict]} · risk {cmp.before.risk.value} · confidence {cmp.before.confidence.level}</p>
      </div>
    );
  }
  const a = cmp.after;
  const b = cmp.before;
  const headline =
    outcome === "no_evidence" ? "No additional evidence was found. The assessment is as it was."
    : cmp.verdictChanged ? <>Verdict changed: <span className="text-ink-muted">{VERDICT_LABEL[b.verdict]}</span> → <span className={TONE[a.verdict]}>{VERDICT_LABEL[a.verdict]}</span></>
    : <>Verdict unchanged: <span className={TONE[a.verdict]}>{VERDICT_LABEL[a.verdict]}</span></>;
  return (
    <div data-testid="assessment" data-outcome={outcome}>
      <p role="status" className="t-display text-[clamp(16px,1.9vw,26px)] text-ink" data-testid="assessment-headline">{headline}</p>
      {!cmp.verdictChanged && outcome !== "no_evidence" && (
        <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-muted">An unchanged verdict is a valid result: the retrieved evidence did not move the conclusion.</p>
      )}
      {outcome === "no_evidence" && <p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink-muted">The query ran and returned nothing. It still used one query from the budget.</p>}

      <div className="mt-8 grid gap-x-12 gap-y-8 lg:grid-cols-2">
        {([["Before", b.verdict, b.risk.value, b.risk.band, b.confidence.level, cmp.coverageBefore] , ["After", a.verdict, a.risk.value, a.risk.band, a.confidence.level, cmp.coverageAfter]] as const).map(([label, verdict, risk, rb, conf, cov], idx) => (
          <section key={label} aria-label={`${label} the query`} className={idx ? "mat-lit brk relative px-6 py-5" : "mat-raised px-6 py-5"}>
            <h3 className="t-micro text-ink">{label}</h3>
            <p className={`t-display mt-4 text-[clamp(18px,1.8vw,26px)] ${TONE[verdict]}`} data-testid={`${label.toLowerCase()}-verdict`}>{VERDICT_LABEL[verdict]}</p>
            <dl className="mt-5 grid grid-cols-3 gap-4">
              <div><dt className="t-label">Risk (heuristic)</dt><dd className="mt-1.5"><span className="t-display text-[20px] tabular-nums" data-testid={`${label.toLowerCase()}-risk`}>{risk}</span> <span className="text-[11px] uppercase tracking-wider text-ink-faint">{rb}</span></dd></div>
              <div><dt className="t-label">Confidence</dt><dd className="mt-1.5 text-[14px] capitalize text-ink" data-testid={`${label.toLowerCase()}-confidence`}>{conf}</dd></div>
              <div><dt className="t-label">Coverage</dt><dd className="mt-1.5 text-[14px] tabular-nums text-ink" data-testid={`${label.toLowerCase()}-coverage`}>{cov === null ? <span className="text-ink-faint">not returned</span> : pctOf(cov)}</dd></div>
            </dl>
          </section>
        ))}
      </div>

      <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[12.5px] text-ink-muted" aria-label="Changes">
        <li data-testid="delta-risk">Risk {cmp.riskDelta === 0 ? "unchanged" : `${signed(cmp.riskDelta ?? 0)} (${b.risk.value} → ${a.risk.value})`}</li>
        <li data-testid="delta-confidence">Confidence {cmp.confidenceChanged ? `${b.confidence.level} → ${a.confidence.level}` : "unchanged"}</li>
        <li data-testid="delta-coverage">Coverage {cmp.coverageAfter === null ? "not returned" : cmp.coverageChanged ? `${pctOf(cmp.coverageBefore)} → ${pctOf(cmp.coverageAfter)}` : "unchanged"}</li>
      </ul>

      <div className="mt-10 grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <section aria-labelledby="inv-find-h">
          <h3 id="inv-find-h" className="t-micro text-ink">New or changed findings</h3>
          {cmp.addedFindings.length + cmp.changedFindings.length + cmp.removedFindings.length === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-muted" data-testid="no-finding-change">No findings were added, removed or changed.</p>
          ) : (
            <ul className="mt-4 space-y-3" data-testid="finding-changes">
              {cmp.addedFindings.map((f) => <FindingLine key={f.finding_id} f={f} tag="new" />)}
              {cmp.changedFindings.map(({ after }) => <FindingLine key={after.finding_id} f={after} tag="changed" />)}
              {cmp.removedFindings.map((f) => <FindingLine key={f.finding_id} f={f} tag="removed" />)}
            </ul>
          )}
        </section>
        <section aria-labelledby="inv-rem-h">
          <h3 id="inv-rem-h" className="t-micro text-ink">Remaining uncertainty</h3>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-muted"><span className="t-label mr-2">Confidence rationale</span>{cmp.remaining?.rationale}</p>
          {(cmp.remaining?.missing.length ?? 0) + (cmp.remaining?.coverageMissing.length ?? 0) === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-muted">The backend lists no missing evidence for this case.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-[13.5px] text-ink-muted" data-testid="remaining-missing">
              {[...new Set([...(cmp.remaining?.missing ?? []), ...(cmp.remaining?.coverageMissing ?? [])])].map((m) => (
                <li key={m} className="border-l border-dashed border-missing pl-3">{m} <span className="text-ink-faint">· still missing</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {(cmp.mismatches.length > 0 || cmp.budgetMismatch) && (
        <ul className="mt-6 space-y-1.5 text-[13px] text-suspicious" data-testid="integrity-notes">
          {cmp.mismatches.length > 0 && <li className="flex gap-2"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />The response's “previous” assessment differs from the case held before the query ({cmp.mismatches.join("; ")}). Backend values are shown unmodified.</li>}
          {cmp.budgetMismatch && <li className="flex gap-2"><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />The response's budget_remaining differs from the one inside updated_case. The top-level value is shown.</li>}
        </ul>
      )}
    </div>
  );
}
