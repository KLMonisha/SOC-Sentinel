import type { CaseStatus, Severity, Verdict } from "@/api/types";

export const VERDICT_LABEL: Record<Verdict, string> = {
  likely_malicious: "Likely malicious",
  needs_investigation: "Needs investigation",
  likely_benign: "Likely benign",
  insufficient_evidence: "Insufficient evidence",
};

export const STATUS_LABEL: Record<CaseStatus, string> = {
  open: "Open",
  approved: "Approved (dry-run)",
  rejected: "Rejected",
};

export const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");
}
