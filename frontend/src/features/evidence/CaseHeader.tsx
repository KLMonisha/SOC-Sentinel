import { Link } from "react-router-dom";
import { ArrowLeft, FileText } from "lucide-react";
import { VerdictLabel } from "@/components/ui/Badges";
import { STATUS_LABEL } from "@/lib/format";
import { reportPath } from "@/features/report/citations";
import { useInvestigation } from "./InvestigationProvider";

function Metric({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-28 border-l border-line px-3" title={hint}>
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</div>
      <div className="mt-0.5 text-[13px]">{children}</div>
    </div>
  );
}

export function CaseHeader() {
  const { caseDetail: c, state } = useInvestigation();
  const s = c.summary;
  const replaying = state.replay < state.total;
  return (
    <header className="border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link to="/app" className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
          <ArrowLeft size={13} aria-hidden /> Command Center
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{s.title}</h1>
          <p className="font-mono text-[11px] text-ink-faint">{s.case_id} · dataset {s.dataset_id}</p>
        </div>
        <div className="flex flex-wrap gap-y-2">
          <Metric label="Verdict" hint="The overall verdict for the full investigation">
            <VerdictLabel verdict={s.verdict} />
          </Metric>
          <Metric label="Risk (heuristic)" hint="0–100 heuristic score. Not a probability of attack.">
            <span className="font-mono">{s.risk_score.value}</span>
            <span className="text-ink-faint"> · {s.risk_score.band}</span>
          </Metric>
          <Metric label="Confidence"><span className="capitalize">{c.confidence.level}</span></Metric>
          <Metric label="Evidence coverage" hint="Share of expected telemetry present">
            <span className="font-mono">{Math.round(c.coverage.ratio * 100)}%</span>
          </Metric>
          <Metric label="Status">{STATUS_LABEL[s.status]}</Metric>
        </div>
        <Link to={reportPath(s.case_id)} className="inline-flex items-center gap-2 border border-verified/50 px-3.5 py-2 text-[11px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/10">
          <FileText size={13} aria-hidden /> Report
        </Link>
      </div>
      {replaying && (
        <p role="note" className="border-t border-line px-4 py-1.5 text-[11px] text-suspicious">
          Replay in progress: the verdict and scores above are the overall result for the full investigation, not the state at the replay position.
        </p>
      )}
    </header>
  );
}
