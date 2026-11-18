import type { ReactNode } from "react";
import type { Finding } from "@/api/types";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { SeverityBadge, VerdictLabel } from "@/components/ui/Badges";
import { STATUS_LABEL, formatTime } from "@/lib/format";
import { EventChip } from "./EventChip";
import { useInvestigation } from "./InvestigationProvider";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-b border-line py-4 first:pt-0 last:border-b-0">
      <h3 className="mb-2 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {title}{count !== undefined ? ` (${count})` : ""}
      </h3>
      {children}
    </section>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const { selectNode } = useInvestigation();
  return (
    <li className="border border-line p-2.5">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => selectNode(`finding:${f.finding_id}`)} className="text-left text-[13px] underline-offset-2 hover:underline">
          {f.title}
        </button>
        <SeverityBadge severity={f.severity} />
      </div>
      <p className="mt-1 text-[12px] text-ink-muted">{f.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-ink-faint">{f.rule_id} · weight {f.weight > 0 ? "+" : ""}{f.weight}</span>
        {f.event_ids.map((id) => <EventChip key={id} eventId={id} />)}
      </div>
    </li>
  );
}

export function AnalysisPanel() {
  const { caseDetail: c } = useInvestigation();
  const supporting = c.findings.filter((f) => f.stance === "supporting");
  const contradicting = c.findings.filter((f) => f.stance === "contradicting");

  return (
    <div>
      <Section title="Verdict">
        <div className="mb-2"><VerdictLabel verdict={c.summary.verdict} /></div>
        <p className="text-[12px] text-ink-muted">{c.verdict_rationale}</p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
          <div className="border border-line p-2">
            <dt className="text-[10px] uppercase text-ink-faint" title="Heuristic 0–100. Not a probability.">Risk (heuristic)</dt>
            <dd className="font-mono text-base">{c.summary.risk_score.value}</dd>
            <dd className="text-ink-faint">{c.summary.risk_score.band}</dd>
          </div>
          <div className="border border-line p-2">
            <dt className="text-[10px] uppercase text-ink-faint">Confidence</dt>
            <dd className="text-base capitalize">{c.confidence.level}</dd>
          </div>
          <div className="border border-line p-2">
            <dt className="text-[10px] uppercase text-ink-faint">Coverage</dt>
            <dd className="font-mono text-base">{Math.round(c.coverage.ratio * 100)}%</dd>
          </div>
        </dl>
        <p className="mt-2 text-[12px] text-ink-muted"><span className="text-ink-faint">Confidence rationale: </span>{c.confidence.rationale}</p>
        {c.summary.risk_score.reasoning.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-[11px] text-ink-faint">
            {c.summary.risk_score.reasoning.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
      </Section>

      <Section title="Supporting evidence" count={supporting.length}>
        {supporting.length === 0
          ? <p className="text-[12px] text-ink-muted">No supporting findings reported.</p>
          : <ul className="space-y-2">{supporting.map((f) => <FindingRow key={f.finding_id} f={f} />)}</ul>}
      </Section>

      <Section title="Contradicting evidence" count={contradicting.length}>
        {contradicting.length === 0
          ? <p className="text-[12px] text-ink-muted">The backend reported no contradicting findings for this case.</p>
          : <ul className="space-y-2">{contradicting.map((f) => <FindingRow key={f.finding_id} f={f} />)}</ul>}
      </Section>

      <Section title="Missing telemetry" count={c.missing_evidence.length}>
        <p className="mb-2 text-[11px] text-suspicious">Missing is not benign: these are unknowns that limit the conclusion.</p>
        {c.missing_evidence.length === 0 ? <p className="text-[12px] text-ink-muted">None reported.</p> : (
          <ul className="space-y-2">
            {c.missing_evidence.map((m) => (
              <li key={m.missing_id} className="border border-dashed border-missing/60 p-2.5 text-[12px]">
                <div className="flex items-center gap-2"><EvidenceBadge state="missing" /><span>{m.telemetry}</span></div>
                <p className="mt-1 text-ink-muted">{m.why_it_matters}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-ink-faint">
          Coverage present: {c.coverage.present.join(", ") || "none"} · missing: {c.coverage.missing.join(", ") || "none"}
        </p>
      </Section>

      <Section title="MITRE ATT&CK" count={c.attack_mappings.length}>
        {c.attack_mappings.length === 0 ? <p className="text-[12px] text-ink-muted">No mappings reported.</p> : (
          <ul className="space-y-2">
            {c.attack_mappings.map((m) => (
              <li key={m.technique_id} className="text-[12px]">
                <span className="font-mono">{m.technique_id}</span> {m.name} <span className="text-ink-faint">· {m.tactic}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">{m.event_ids.map((id) => <EventChip key={id} eventId={id} />)}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Status and analyst decisions">
        <p className="text-[12px]">{STATUS_LABEL[c.summary.status]}</p>
        {c.decisions.length === 0 ? <p className="mt-1 text-[12px] text-ink-muted">No analyst decision recorded.</p> : (
          <ul className="mt-2 space-y-1 text-[12px]">
            {c.decisions.map((d) => (
              <li key={d.decision_id} className="font-mono text-[11px] text-ink-muted">
                {formatTime(d.decided_at)} · {d.decision} · {d.analyst_id} · dry-run
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
