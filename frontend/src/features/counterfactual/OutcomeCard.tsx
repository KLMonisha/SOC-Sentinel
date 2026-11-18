import type { Confidence, Coverage, Finding, RiskScore, Verdict } from "@/api/types";
import { Surface } from "@/components/ui/Surface";
import { VERDICT_LABEL } from "@/lib/format";

const VERDICT_TONE: Record<Verdict, string> = {
  likely_malicious: "text-critical",
  needs_investigation: "text-suspicious",
  likely_benign: "text-verified",
  insufficient_evidence: "text-missing",
};

export type Mark = "removed" | "added" | "changed";

interface Props {
  kind: "original" | "recomputed";
  innerRef?: React.Ref<HTMLElement>;
  verdict: Verdict;
  risk: RiskScore;
  confidence: Confidence;
  /** `null` = the backend did not return coverage for this outcome (shown explicitly, never derived). */
  coverage: Coverage | null;
  findings: Finding[];
  marks?: ReadonlyMap<string, Mark>;
  /** Stored findings that cite the event currently selected for exclusion. */
  citing?: ReadonlySet<string>;
  selectedEventId?: string | null;
  riskDelta?: number;
  /** Removed findings are not in the recomputed list; show them struck through for orientation. */
  ghosts?: Finding[];
}

const MARK_LABEL: Record<Mark, string> = { removed: "removed", added: "new", changed: "changed" };

/** One side of the branch. The original is the stored case; the recomputed one is the backend's rerun. */
export function OutcomeCard({ kind, innerRef, verdict, risk, confidence, coverage, findings, marks, citing, selectedEventId, riskDelta, ghosts = [] }: Props) {
  const original = kind === "original";
  const all = [...findings.map((f) => ({ f, ghost: false })), ...ghosts.map((f) => ({ f, ghost: true }))];
  return (
    <Surface
      as="section"
      level={original ? "raised" : "lit"}
      brackets={!original}
      aria-label={original ? "Original, stored case" : "Recomputed branch"}
      className="relative px-6 py-6"
      {...({ ref: innerRef } as object)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="t-micro text-ink">{original ? "Original · stored case" : "Recomputed · branch"}</h2>
        <span className="t-label">{original ? "never modified" : "hypothetical"}</span>
      </div>

      <div className={`t-display mt-5 text-[clamp(20px,2.1vw,30px)] ${VERDICT_TONE[verdict]}`} data-testid={`${kind}-verdict`}>{VERDICT_LABEL[verdict]}</div>

      <dl className="mt-5 grid grid-cols-3 gap-4">
        <div>
          <dt className="t-label">Risk (heuristic)</dt>
          <dd className="mt-1.5 flex items-baseline gap-2">
            <span className="t-display text-[22px] tabular-nums text-ink" data-testid={`${kind}-risk`}>{risk.value}</span>
            <span className="text-[11px] uppercase tracking-wider text-ink-faint">{risk.band}</span>
            {riskDelta !== undefined && riskDelta !== 0 && (
              <span className={`font-mono text-[12px] ${riskDelta < 0 ? "text-verified" : "text-suspicious"}`} aria-label={`change ${riskDelta > 0 ? "plus" : "minus"} ${Math.abs(riskDelta)}`}>
                {riskDelta > 0 ? "+" : "−"}{Math.abs(riskDelta)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="t-label">Confidence</dt>
          <dd className="mt-1.5 text-[15px] capitalize text-ink">{confidence.level}</dd>
        </div>
        <div>
          <dt className="t-label">Coverage</dt>
          <dd className="mt-1.5 text-[15px] text-ink">
            {coverage ? <>{Math.round(coverage.ratio * 100)}<span className="text-ink-faint">%</span></> : <span className="text-[12.5px] text-ink-faint">not returned</span>}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">{confidence.rationale}</p>

      <h3 className="t-label mt-6">Findings ({findings.length})</h3>
      {all.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-muted">No findings.</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {all.map(({ f, ghost }) => {
            const mark = ghost ? "removed" : marks?.get(f.finding_id);
            const lit = citing?.has(f.finding_id);
            return (
              <li
                key={`${f.finding_id}${ghost ? ":g" : ""}`}
                className={`relative px-3.5 py-2.5 text-[13px] ${lit ? "mat-lit" : "mat-plane"} ${mark === "removed" ? "opacity-60" : ""}`}
                style={mark ? { boxShadow: `inset 2px 0 0 ${mark === "removed" ? "#d6595f" : mark === "added" ? "#63ebd8" : "#e8a15d"}` } : undefined}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-ink ${mark === "removed" ? "line-through decoration-critical/70" : ""}`}>
                    <span aria-hidden className="mr-1.5 text-[10px]">{f.stance === "contradicting" ? "▼" : "▲"}</span>
                    {f.title}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">{f.weight > 0 ? "+" : ""}{f.weight}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                  <span className="font-mono">{f.rule_id}</span>
                  <span>{f.stance}</span>
                  {mark && <span className="font-medium uppercase tracking-wider text-ink">{MARK_LABEL[mark]}</span>}
                  {lit && selectedEventId && <span className="text-verified">cites {selectedEventId}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Surface>
  );
}

/** The branch before it has been run: hollow, dashed, explicit. */
export function BranchPlaceholder({ innerRef, state }: { innerRef?: React.Ref<HTMLElement>; state: "idle" | "running" }) {
  return (
    <section
      ref={innerRef} aria-label="Recomputed branch (not yet available)"
      className="relative grid min-h-[320px] place-items-center border border-dashed border-line-strong px-8 py-10 text-center"
    >
      <div>
        <h2 className="t-micro text-ink-muted">Recomputed · branch</h2>
        {state === "running" ? (
          <p role="status" className="mx-auto mt-4 max-w-xs text-[13.5px] text-ink-muted">
            Recomputing. The backend is re-running detection, correlation and scoring on the case without the selected event.
          </p>
        ) : (
          <p className="mx-auto mt-4 max-w-xs text-[13.5px] text-ink-faint">
            This branch does not exist yet. Choose an event to exclude, give a reason, and the backend will rerun the analysis without it.
          </p>
        )}
      </div>
    </section>
  );
}
