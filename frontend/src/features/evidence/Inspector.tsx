import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { SourceEvent } from "@/api/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { SeverityBadge } from "@/components/ui/Badges";
import { formatTime } from "@/lib/format";
import { EventChip } from "./EventChip";
import { useInvestigation } from "./InvestigationProvider";
import { eventIdOfNode } from "./model/graphModel";

const NA = <span className="text-ink-faint">Not available</span>;

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 border-b border-line/50 py-1.5 text-[12px]">
      <dt className="text-ink-faint">{k}</dt>
      <dd className="min-w-0 break-words font-mono">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-faint">{title}</h4>
      {children}
    </section>
  );
}

function SourceEventView({ event }: { event: SourceEvent }) {
  const { caseDetail, orderedEvents } = useInvestigation();
  const findings = caseDetail.findings.filter((f) => f.event_ids.includes(event.event_id));
  const attack = caseDetail.attack_mappings.filter((m) => m.event_ids.includes(event.event_id));
  const relatedIds = new Set<string>();
  for (const f of findings) for (const id of f.event_ids) if (id !== event.event_id) relatedIds.add(id);
  const related = orderedEvents.filter((e) => relatedIds.has(e.event_id));
  const unresolvedRelated = [...relatedIds].filter((id) => !orderedEvents.some((e) => e.event_id === id));

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-mono text-sm">{event.event_id}</h3>
        <EvidenceBadge state="observed" />
      </div>
      <Section title="Original log record (untrusted text)">
        {/* Rendered as inert text; never interpreted as HTML. */}
        <pre data-testid="raw-log" className="max-h-40 overflow-auto whitespace-pre-wrap break-all border border-line bg-bg p-2.5 font-mono text-[12px] leading-relaxed">
          {event.raw_text}
        </pre>
        <p className="mt-1 text-[11px] text-ink-faint">
          Stored verbatim from {event.source_file}, line {event.line_number}. Normalized fields below are parsed from it, not a replacement for it.
        </p>
      </Section>
      <Section title="Provenance">
        <dl>
          <Row k="Dataset">{caseDetail.summary.dataset_id}</Row>
          <Row k="Source file">{event.source_file || NA}</Row>
          <Row k="Line">{event.line_number}</Row>
          <Row k="Record SHA-256">{event.raw_hash || NA}</Row>
        </dl>
      </Section>
      <Section title="Normalized fields">
        <dl>
          <Row k="Timestamp">{formatTime(event.timestamp)}</Row>
          <Row k="Event type">{event.event_type}</Row>
          <Row k="Outcome">{event.outcome}</Row>
          <Row k="Username">{event.username ?? NA}</Row>
          <Row k="Source IP">{event.source_ip ?? NA}</Row>
          <Row k="Host">{event.host ?? NA}</Row>
          <Row k="Resource">{event.resource ?? NA}</Row>
        </dl>
      </Section>
      <Section title="Associated findings">
        {findings.length === 0 ? <p className="text-[12px] text-ink-muted">No findings cite this event.</p> : (
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li key={f.finding_id} className="text-[12px]">
                <FindingLink id={f.finding_id} title={f.title} /> <span className="text-ink-faint">· {f.stance}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="ATT&CK mappings">
        {attack.length === 0 ? <p className="text-[12px] text-ink-muted">None reported for this event.</p> : (
          <ul className="text-[12px]">{attack.map((m) => <li key={m.technique_id}><span className="font-mono">{m.technique_id}</span> {m.name} <span className="text-ink-faint">· {m.tactic}</span></li>)}</ul>
        )}
      </Section>
      <Section title="Related events (via shared findings)">
        {related.length === 0 && unresolvedRelated.length === 0 ? <p className="text-[12px] text-ink-muted">None.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {related.map((e) => <EventChip key={e.event_id} eventId={e.event_id} />)}
            {unresolvedRelated.map((id) => <EventChip key={id} eventId={id} />)}
          </div>
        )}
      </Section>
    </div>
  );
}

function FindingLink({ id, title }: { id: string; title: string }) {
  const { selectNode } = useInvestigation();
  return (
    <button type="button" onClick={() => selectNode(`finding:${id}`)} className="text-left underline-offset-2 hover:underline">
      {title}
    </button>
  );
}

export function Inspector() {
  const { state, eventsById, fullGraph, caseDetail, orderedEvents, visibleEventIds, dispatch } = useInvestigation();
  const sel = state.selection;
  if (!sel) {
    return <EmptyState title="Nothing selected" detail="Select a node, edge, event or finding to inspect the underlying evidence." />;
  }

  const clear = (
    <button type="button" onClick={() => dispatch({ type: "clear" })} className="mb-3 text-[11px] text-ink-muted underline underline-offset-2 hover:text-ink">
      Clear selection
    </button>
  );

  if (sel.kind === "edge") {
    const e = fullGraph.edges.find((x) => x.id === sel.id);
    if (!e) return <>{clear}<EmptyState title="Relationship not found" detail="The selected relationship is not part of this case." /></>;
    const name = (id: string) => fullGraph.nodes.find((n) => n.id === id)?.label ?? id;
    return (
      <div>
        {clear}
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm">Relationship</h3><EvidenceBadge state={e.state} /></div>
        <dl>
          <Row k="From">{name(e.source)}</Row>
          <Row k="Relation">{e.relation}</Row>
          <Row k="To">{name(e.target)}</Row>
        </dl>
        <Section title={e.state === "observed" ? "Established by" : "Basis (not directly observed)"}>
          <p className="text-[12px]">{e.basis}</p>
          {e.state !== "observed" && (
            <p className="mt-1 text-[11px] text-suspicious">
              {e.state === "inferred" ? "Inferred: treat as a hypothesis, not a fact in the logs." : "Missing: no telemetry establishes this link."}
            </p>
          )}
        </Section>
        <Section title="Source events">
          {e.eventIds.length === 0 ? <p className="text-[12px] text-ink-muted">No source events: this link is unresolved.</p> : (
            <div className="flex flex-wrap gap-1.5">{e.eventIds.map((id) => <EventChip key={id} eventId={id} />)}</div>
          )}
        </Section>
      </div>
    );
  }

  const evId = eventIdOfNode(sel.id);
  if (evId !== null) {
    const ev = eventsById.get(evId);
    if (!ev) {
      return (
        <div>{clear}
          <div role="alert" className="border border-critical/50 p-3 text-[13px]">
            <p className="flex items-center gap-2 text-critical"><AlertTriangle size={14} aria-hidden /> Unresolved event reference</p>
            <p className="mt-1 font-mono text-[12px]">{evId}</p>
            <p className="mt-1 text-ink-muted">This ID does not match any stored event in this case, so no source record can be shown.</p>
          </div>
        </div>
      );
    }
    return <div>{clear}<SourceEventView event={ev} /></div>;
  }

  const node = fullGraph.nodes.find((n) => n.id === sel.id);
  if (!node) return <>{clear}<EmptyState title="Selection not found" detail="The selected item is not part of this case." /></>;

  if (node.kind === "finding") {
    const f = caseDetail.findings.find((x) => x.finding_id === node.findingId);
    const attack = caseDetail.attack_mappings.filter((m) => m.event_ids.some((id) => f?.event_ids.includes(id)));
    return (
      <div>{clear}
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm">{node.label}</h3>{f && <SeverityBadge severity={f.severity} />}</div>
        {f && (
          <>
            <dl>
              <Row k="Rule">{f.rule_id}</Row>
              <Row k="Stance">{f.stance}</Row>
              <Row k="Weight">{f.weight > 0 ? `+${f.weight}` : f.weight} (heuristic)</Row>
            </dl>
            <p className="mt-2 text-[12px]">{f.description}</p>
            <Section title="Cited source events">
              <div className="flex flex-wrap gap-1.5">{f.event_ids.map((id) => <EventChip key={id} eventId={id} />)}</div>
            </Section>
            <Section title="ATT&CK mappings">
              {attack.length === 0 ? <p className="text-[12px] text-ink-muted">None reported.</p> : (
                <ul className="text-[12px]">{attack.map((m) => <li key={m.technique_id}><span className="font-mono">{m.technique_id}</span> {m.name}</li>)}</ul>
              )}
            </Section>
          </>
        )}
      </div>
    );
  }

  if (node.kind === "missing") {
    const m = caseDetail.missing_evidence.find((x) => `missing:${x.missing_id}` === node.id);
    return (
      <div>{clear}
        <div className="mb-2 flex items-center gap-2"><h3 className="text-sm">{node.label}</h3><EvidenceBadge state="missing" /></div>
        <p className="text-[12px]">{m?.why_it_matters ?? "No explanation supplied."}</p>
        <p className="mt-2 text-[11px] text-suspicious">Missing telemetry is an unknown, not evidence that the activity was benign.</p>
      </div>
    );
  }

  // Entity (user / ip / host) or backend-reported node.
  const edges = fullGraph.edges.filter((e) => e.source === node.id || e.target === node.id);
  const eventIds = [...new Set(edges.flatMap((e) => e.eventIds))].filter((id) => visibleEventIds.has(id));
  const findings = caseDetail.findings.filter((f) => f.event_ids.some((id) => eventIds.includes(id)));
  return (
    <div>{clear}
      <div className="mb-2 flex items-center gap-2"><h3 className="text-sm capitalize">{node.kind}: <span className="font-mono">{node.label}</span></h3><EvidenceBadge state={node.state} /></div>
      <Section title={`Source events (${eventIds.length})`}>
        {eventIds.length === 0 ? <p className="text-[12px] text-ink-muted">No revealed source events reference this entity.</p> : (
          <div className="flex flex-wrap gap-1.5">{orderedEvents.filter((e) => eventIds.includes(e.event_id)).map((e) => <EventChip key={e.event_id} eventId={e.event_id} />)}</div>
        )}
      </Section>
      <Section title="Findings involving these events">
        {findings.length === 0 ? <p className="text-[12px] text-ink-muted">None.</p> : (
          <ul className="space-y-1 text-[12px]">{findings.map((f) => <li key={f.finding_id}><FindingLink id={f.finding_id} title={f.title} /></li>)}</ul>
        )}
      </Section>
    </div>
  );
}
