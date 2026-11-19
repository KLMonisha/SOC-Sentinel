import type { CaseDetail, CaseOutcome, CounterfactualResponse, Finding } from "@/api/types";

/**
 * Pure comparison of a stored case against a counterfactual response. Nothing here computes a verdict or a
 * score: it only describes the difference between two outcomes the backend produced.
 */
export interface Comparison {
  verdictChanged: boolean;
  riskDelta: number;
  riskDeltaMatchesReported: boolean;
  confidenceChanged: boolean;
  /** Findings present before and after with no reported change. */
  unchangedFindings: Finding[];
  /** Events cited by the original findings but by none of the recomputed ones. Derived from returned findings. */
  noLongerCited: string[];
  newlyCited: string[];
  /** The response's `original` is supposed to be the stored case unchanged. Discrepancies are listed. */
  originalMismatches: string[];
}

const cited = (fs: readonly Finding[]) => new Set(fs.flatMap((f) => f.event_ids));

export function outcomeOfCase(c: CaseDetail): Pick<CaseOutcome, "verdict" | "risk_score" | "confidence" | "findings"> {
  return { verdict: c.summary.verdict, risk_score: c.summary.risk_score, confidence: c.confidence, findings: c.findings };
}

/** What differs between two outcomes, as human-readable discrepancies (empty = identical on the compared fields). */
export function outcomeDifferences(a: Pick<CaseOutcome, "verdict" | "risk_score" | "findings">, b: Pick<CaseOutcome, "verdict" | "risk_score" | "findings">): string[] {
  const out: string[] = [];
  if (a.verdict !== b.verdict) out.push(`verdict ${a.verdict} vs ${b.verdict}`);
  if (a.risk_score.value !== b.risk_score.value) out.push(`risk ${a.risk_score.value} vs ${b.risk_score.value}`);
  const sig = (fs: readonly Finding[]) => fs.map((f) => `${f.finding_id}:${f.weight}:${[...f.event_ids].sort().join(",")}`).sort().join("|");
  if (sig(a.findings) !== sig(b.findings)) out.push("findings differ");
  return out;
}

export function compare(stored: CaseDetail, res: CounterfactualResponse): Comparison {
  const touched = new Set([
    ...res.removed.map((r) => r.finding.finding_id),
    ...res.added.map((a) => a.finding.finding_id),
    ...res.changed.flatMap((c) => [c.before.finding_id, c.after.finding_id]),
  ]);
  const before = cited(res.original.findings);
  const after = cited(res.recomputed.findings);
  const riskDelta = res.recomputed.risk_score.value - res.original.risk_score.value;
  return {
    verdictChanged: res.original.verdict !== res.recomputed.verdict,
    riskDelta,
    riskDeltaMatchesReported: riskDelta === res.score_delta,
    confidenceChanged: res.original.confidence.level !== res.recomputed.confidence.level,
    unchangedFindings: res.recomputed.findings.filter((f) => !touched.has(f.finding_id)),
    noLongerCited: [...before].filter((id) => !after.has(id)).sort(),
    newlyCited: [...after].filter((id) => !before.has(id)).sort(),
    originalMismatches: outcomeDifferences(outcomeOfCase(stored), res.original),
  };
}

/** Which stored findings cite a given event (a fact about the stored case, not a prediction of the outcome). */
export const findingsCiting = (c: CaseDetail, eventId: string): Finding[] => c.findings.filter((f) => f.event_ids.includes(eventId));

/** True when two reads of the stored case agree on everything a counterfactual must never change. */
export function storedCaseUnchanged(before: CaseDetail, after: CaseDetail): boolean {
  return outcomeDifferences(outcomeOfCase(before), outcomeOfCase(after)).length === 0 && before.events.length === after.events.length;
}
