import { Link } from "react-router-dom";
import { ArrowLeft, Crosshair, Download, FileText, GitCompareArrows } from "lucide-react";
import { VerdictLabel } from "@/components/ui/Badges";
import { Chip } from "@/components/ui/Chip";
import { config } from "@/lib/config";
import { STATUS_LABEL } from "@/lib/format";
import { reportPath } from "@/features/report/citations";
import { useInvestigation } from "./InvestigationProvider";

function Metric({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-[104px]" title={hint}>
      <div className="t-label">{label}</div>
      <div className="mt-1.5 text-[15px] text-ink">{children}</div>
    </div>
  );
}

const action = "inline-flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-muted transition-colors hover:text-ink";

/** Architectural case header: no box, metrics read as a single instrument line. */
export function CaseHeader() {
  const { caseDetail: c, state, dispatch } = useInvestigation();
  const s = c.summary;
  const replaying = state.replay < state.total;
  const enc = encodeURIComponent(s.case_id);
  return (
    <header className="px-5 pb-5 pt-5 sm:px-8 lg:px-12">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <Link to="/app" className="inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
          <ArrowLeft size={13} aria-hidden /> Command Center
        </Link>
        <nav aria-label="Case actions" className="flex flex-wrap items-center">
          <Link to={`/app/investigation/${enc}`} className={action} title="Find the missing evidence with bounded queries"><Crosshair size={13} aria-hidden /> Investigate</Link>
          <Link to={`/app/counterfactual/${enc}`} className={action} title="Remove evidence and see how the verdict responds"><GitCompareArrows size={13} aria-hidden /> Challenge</Link>
          <button
            type="button" className={action} title="Download the report, CSVs and graph image"
            onClick={() => { dispatch({ type: "setPanel", panel: "export" }); document.getElementById("room-details")?.scrollIntoView({ block: "start", behavior: "auto" }); }}
          >
            <Download size={13} aria-hidden /> Export
          </button>
          <Link to={reportPath(s.case_id)} className="ml-2 inline-flex items-center gap-2 border border-verified/50 px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/10">
            <FileText size={13} aria-hidden /> Report
          </Link>
        </nav>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-12 gap-y-5">
        <div className="min-w-0 max-w-[88ch]">
          <h1 className="text-[clamp(20px,1.9vw,28px)] font-medium leading-tight text-ink">{s.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[12px] text-ink-faint">
            <span>{s.case_id}</span><span aria-hidden>·</span><span>dataset {s.dataset_id}</span><span aria-hidden>·</span><span>{c.events.length} source events</span>
            {config.useMocks && <Chip dashed title="This case is a development fixture.">Development fixture</Chip>}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-5">
          <Metric label="Verdict" hint="The overall verdict for the full investigation"><VerdictLabel verdict={s.verdict} /></Metric>
          <Metric label="Risk (heuristic)" hint="0–100 heuristic score. Not a probability of attack.">
            <span className="t-display text-[20px] tabular-nums">{s.risk_score.value}</span>
            <span className="ml-2 text-[11px] uppercase tracking-wider text-ink-faint">{s.risk_score.band}</span>
          </Metric>
          <Metric label="Confidence"><span className="capitalize">{c.confidence.level}</span></Metric>
          <Metric label="Evidence coverage" hint="Share of expected telemetry present">
            <span className="font-mono">{Math.round(c.coverage.ratio * 100)}%</span>
          </Metric>
          <Metric label="Status">{STATUS_LABEL[s.status]}</Metric>
        </div>
      </div>
      {replaying && (
        <p role="note" className="mt-5 border-l-2 border-suspicious pl-3 text-[12px] text-suspicious">
          Replay in progress: the verdict and scores above are the overall result for the full investigation, not the state at the replay position.
        </p>
      )}
    </header>
  );
}
