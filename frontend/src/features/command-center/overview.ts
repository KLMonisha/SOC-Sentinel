import type { CaseSummary } from "@/api/types";

export interface Overview {
  cases: number;
  /** Open cases whose verdict is not settled (needs investigation or insufficient evidence). */
  unsettled: number;
  open: number;
  highRisk: number;
  events: number;
  byVerdict: Record<CaseSummary["verdict"], number>;
}

/** Everything the Command Center shows as a number is derived here, from CaseSummary fields only. */
export function deriveOverview(cases: readonly CaseSummary[]): Overview {
  const byVerdict: Overview["byVerdict"] = { likely_malicious: 0, needs_investigation: 0, likely_benign: 0, insufficient_evidence: 0 };
  let open = 0;
  let unsettled = 0;
  let highRisk = 0;
  let events = 0;
  for (const c of cases) {
    byVerdict[c.verdict]++;
    events += c.event_count;
    if (c.status === "open") {
      open++;
      if (c.verdict === "needs_investigation" || c.verdict === "insufficient_evidence") unsettled++;
    }
    if (c.risk_score.band === "high") highRisk++;
  }
  return { cases: cases.length, unsettled, open, highRisk, events, byVerdict };
}
