import type { Severity, Verdict } from "@/api/types";
import { VERDICT_LABEL } from "@/lib/format";

const SEV: Record<Severity, string> = {
  critical: "text-critical border-critical/50",
  high: "text-critical/90 border-critical/30",
  medium: "text-suspicious border-suspicious/40",
  low: "text-ink-muted border-line-strong",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-block border px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${SEV[severity]}`}>
      {severity}
    </span>
  );
}

const VERDICT: Record<Verdict, string> = {
  likely_malicious: "text-critical",
  needs_investigation: "text-suspicious",
  likely_benign: "text-verified",
  insufficient_evidence: "text-missing",
};

export function VerdictLabel({ verdict }: { verdict: Verdict }) {
  return <span className={`text-[13px] ${VERDICT[verdict]}`}>{VERDICT_LABEL[verdict]}</span>;
}
