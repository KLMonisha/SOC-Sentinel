import type { CaseStatus, CaseSummary, Severity } from "@/api/types";
import { SEVERITY_ORDER, VERDICT_LABEL } from "@/lib/format";

export interface CaseFilters {
  query: string;
  severity: Severity | "all";
  status: CaseStatus | "all";
}

export const NO_FILTERS: CaseFilters = { query: "", severity: "all", status: "all" };

/** Filters, then orders by severity then heuristic risk score (descending). */
export function filterCases(cases: CaseSummary[], f: CaseFilters): CaseSummary[] {
  const q = f.query.trim().toLowerCase();
  return cases
    .filter((c) => f.severity === "all" || c.severity === f.severity)
    .filter((c) => f.status === "all" || c.status === f.status)
    .filter(
      (c) =>
        !q ||
        [c.case_id, c.title, VERDICT_LABEL[c.verdict], ...c.primary_entities].some((s) => s.toLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.risk_score.value - a.risk_score.value,
    );
}
