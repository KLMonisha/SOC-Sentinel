import type { CaseDetail, CounterfactualResponse, Finding } from "@/api/types";
import { CitationChip } from "@/features/report/CitationChip";
import { resolveCitations } from "@/features/report/citations";
import { VERDICT_LABEL } from "@/lib/format";
import type { Comparison } from "./diff";

function Cites({ caseId, ids, known }: { caseId: string; ids: string[]; known: ReadonlySet<string> }) {
  const { resolved, unresolved } = resolveCitations(ids, known);
  return (
    <span className="flex flex-wrap gap-1.5">
      {resolved.map((id) => <CitationChip key={id} caseId={caseId} eventId={id} resolved />)}
      {unresolved.map((id) => <CitationChip key={id} caseId={caseId} eventId={id} resolved={false} />)}
    </span>
  );
}

function Group({ title, tone, children, count }: { title: string; tone: string; children: React.ReactNode; count: number }) {
  return (
    <div>
      <h3 className="flex items-center gap-2.5 text-[12px] uppercase tracking-[0.16em] text-ink">
        <span aria-hidden className="h-2 w-2" style={{ background: tone }} /> {title} <span className="font-mono text-ink-faint">{count}</span>
      </h3>
      <div className="mt-3">{count === 0 ? <p className="text-[13px] text-ink-faint">None.</p> : children}</div>
    </div>
  );
}

const Row = ({ f, reason, children }: { f: Finding; reason?: string; children?: React.ReactNode }) => (
  <li className="mat-plane px-4 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="text-[13.5px] text-ink">{f.title}</span>
      <span className="font-mono text-[11px] text-ink-faint">{f.rule_id} · {f.weight > 0 ? "+" : ""}{f.weight}</span>
    </div>
    {reason && <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{reason}</p>}
    {children && <div className="mt-2">{children}</div>}
  </li>
);

/** What the backend says changed, grouped, with citations that open the stored evidence. */
export function ResultDetails({ stored, res, cmp, excludedIds }: { stored: CaseDetail; res: CounterfactualResponse; cmp: Comparison; excludedIds: string[] }) {
  const caseId = stored.summary.case_id;
  const known = new Set(stored.events.map((e) => e.event_id));
  return (
    <div className="space-y-10">
      <div className="grid gap-x-12 gap-y-9 lg:grid-cols-2">
        <Group title="Removed findings" tone="#d6595f" count={res.removed.length}>
          <ul className="space-y-2.5">{res.removed.map((r) => <Row key={r.finding.finding_id} f={r.finding} reason={r.reason}><Cites caseId={caseId} ids={r.finding.event_ids} known={known} /></Row>)}</ul>
        </Group>
        <Group title="Added findings" tone="#63ebd8" count={res.added.length}>
          <ul className="space-y-2.5">{res.added.map((a) => <Row key={a.finding.finding_id} f={a.finding} reason={a.reason}><Cites caseId={caseId} ids={a.finding.event_ids} known={known} /></Row>)}</ul>
        </Group>
        <Group title="Changed findings" tone="#e8a15d" count={res.changed.length}>
          <ul className="space-y-2.5">
            {res.changed.map((c) => (
              <Row key={c.after.finding_id} f={c.after} reason={c.reason}>
                <p className="mb-2 font-mono text-[11.5px] text-ink-muted">weight {c.before.weight} → {c.after.weight} · events {c.before.event_ids.length} → {c.after.event_ids.length}</p>
                <Cites caseId={caseId} ids={c.after.event_ids} known={known} />
              </Row>
            ))}
          </ul>
        </Group>
        <Group title="Unchanged findings" tone="#6b827b" count={cmp.unchangedFindings.length}>
          <ul className="space-y-2.5">{cmp.unchangedFindings.map((f) => <Row key={f.finding_id} f={f} />)}</ul>
        </Group>
      </div>

      <div>
        <h3 className="text-[12px] uppercase tracking-[0.16em] text-ink">Evidence differences</h3>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-8 gap-y-4 text-[13.5px]">
          <dt className="t-label pt-1">Excluded</dt>
          <dd><Cites caseId={caseId} ids={excludedIds} known={known} /></dd>
          <dt className="t-label pt-1">No longer cited</dt>
          <dd>{cmp.noLongerCited.length ? <Cites caseId={caseId} ids={cmp.noLongerCited} known={known} /> : <span className="text-ink-faint">Every event cited before is still cited by a recomputed finding.</span>}</dd>
          <dt className="t-label pt-1">Newly cited</dt>
          <dd>{cmp.newlyCited.length ? <Cites caseId={caseId} ids={cmp.newlyCited} known={known} /> : <span className="text-ink-faint">None.</span>}</dd>
        </dl>
        <p className="mt-3 text-[12px] text-ink-faint">Derived from the findings the backend returned; the lists are not computed from any other source.</p>
      </div>

      <div>
        <h3 className="text-[12px] uppercase tracking-[0.16em] text-ink">Backend explanation</h3>
        <p className="mt-3 max-w-[78ch] text-[14.5px] leading-relaxed text-ink-muted">{res.explanation || "The backend returned no explanation."}</p>
      </div>
    </div>
  );
}

/** Accessible structured comparison: the same facts as the branch view, as a table. */
export function ComparisonTable({ res, storedCoverage, cmp }: { res: CounterfactualResponse; storedCoverage: number; cmp: Comparison }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-y-1 text-left text-[13.5px]">
        <caption className="sr-only">Original versus recomputed outcome</caption>
        <thead><tr className="t-label"><th scope="col" className="px-4 py-1 font-normal">Measure</th><th scope="col" className="font-normal">Original (stored)</th><th scope="col" className="font-normal">Recomputed</th><th scope="col" className="font-normal">Change</th></tr></thead>
        <tbody>
          <tr className="mat-plane"><th scope="row" className="px-4 py-3 font-normal text-ink-muted">Verdict</th><td>{VERDICT_LABEL[res.original.verdict]}</td><td>{VERDICT_LABEL[res.recomputed.verdict]}</td><td>{cmp.verdictChanged ? "Changed" : "Unchanged"}</td></tr>
          <tr className="mat-plane"><th scope="row" className="px-4 py-3 font-normal text-ink-muted">Risk (heuristic)</th><td className="font-mono">{res.original.risk_score.value} · {res.original.risk_score.band}</td><td className="font-mono">{res.recomputed.risk_score.value} · {res.recomputed.risk_score.band}</td><td className="font-mono">{res.score_delta > 0 ? "+" : ""}{res.score_delta}</td></tr>
          <tr className="mat-plane"><th scope="row" className="px-4 py-3 font-normal text-ink-muted">Confidence</th><td className="capitalize">{res.original.confidence.level}</td><td className="capitalize">{res.recomputed.confidence.level}</td><td>{cmp.confidenceChanged ? "Changed" : "Unchanged"}</td></tr>
          <tr className="mat-plane"><th scope="row" className="px-4 py-3 font-normal text-ink-muted">Coverage</th><td className="font-mono">{Math.round(storedCoverage * 100)}%</td><td className="text-ink-faint">Not returned by the backend</td><td className="text-ink-faint">—</td></tr>
          <tr className="mat-plane"><th scope="row" className="px-4 py-3 font-normal text-ink-muted">Findings</th><td className="font-mono">{res.original.findings.length}</td><td className="font-mono">{res.recomputed.findings.length}</td><td className="font-mono text-[12px]">−{res.removed.length} · +{res.added.length} · ~{res.changed.length}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
