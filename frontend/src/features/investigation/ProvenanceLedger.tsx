import { Link } from "react-router-dom";
import { ArrowUpRight, ShieldAlert } from "lucide-react";
import type { CaseDetail, SourceEvent } from "@/api/types";
import { SeverityBadge } from "@/components/ui/Badges";
import { evidencePath } from "@/features/report/citations";
import { formatTime } from "@/lib/format";
import { entitiesOf, findingsCiting, provenanceIssues } from "./model";

/**
 * Provenance ledger. Every row is an event the backend actually returned. Raw log text is untrusted:
 * it is rendered as inert text (React escapes it) and never interpreted. A missing provenance field is
 * shown as missing, never filled in.
 */
export function ProvenanceLedger({ caseId, events, newIds, updated }: {
  caseId: string;
  events: SourceEvent[];
  newIds: ReadonlySet<string>;
  /** The case as returned after the query; used to resolve Evidence Room links and relevant findings. */
  updated: CaseDetail | null;
}) {
  const resolvable = new Set(updated?.events.map((e) => e.event_id) ?? []);
  return (
    <ol className="divide-y divide-line" data-testid="ledger">
      {events.map((e, i) => {
        const issues = provenanceIssues(e);
        const findings = findingsCiting(updated, e.event_id);
        const inRoom = resolvable.has(e.event_id) && !!e.event_id;
        return (
          <li key={e.event_id || `row-${i}`} className="inv-rise grid gap-x-10 gap-y-4 py-6 lg:grid-cols-[220px_minmax(0,1fr)]" style={{ ["--i" as string]: i }} data-testid="ledger-row" data-event-id={e.event_id}>
            <div className="min-w-0">
              <p className="break-all font-mono text-[13px] text-verified" data-testid="ledger-id">{e.event_id || <span className="text-suspicious">event ID missing</span>}</p>
              <p className="mt-1.5 font-mono text-[12px] text-ink-muted" data-testid="ledger-time">{e.timestamp ? formatTime(e.timestamp) : <span className="text-suspicious">timestamp missing</span>}</p>
              <p className="mt-3 font-mono text-[12px] text-ink" data-testid="ledger-source">
                {e.source_file || <span className="text-suspicious">source file missing</span>}
                <span className="text-ink-faint"> : </span>
                {Number.isInteger(e.line_number) ? `line ${e.line_number}` : <span className="text-suspicious">line missing</span>}
              </p>
              <p className="mt-2 inline-block border border-line-strong px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted" data-testid="ledger-new">
                {newIds.has(e.event_id) ? "New to this case" : "Already in case"}
              </p>
            </div>

            <div className="min-w-0">
              <p className="t-label">Raw log record (untrusted text)</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all border-l border-line-strong bg-void/60 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink" data-testid="ledger-raw">{typeof e.raw_text === "string" && e.raw_text !== "" ? e.raw_text : "— raw content missing —"}</pre>
              <p className="mt-3 break-all font-mono text-[11.5px] text-ink-faint" data-testid="ledger-hash"><span className="t-label mr-2">SHA-256</span>{e.raw_hash || <span className="text-suspicious">missing</span>}</p>

              {entitiesOf(e).length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Related entities">
                  {entitiesOf(e).map((x) => (
                    <li key={`${x.kind}:${x.value}`} className="border border-line-strong px-2 py-0.5 font-mono text-[11.5px] text-ink-muted"><span className="mr-1.5 text-ink-faint">{x.kind}</span>{x.value}</li>
                  ))}
                </ul>
              )}

              {findings.length > 0 && (
                <ul className="mt-3 space-y-1.5" aria-label="Relevant findings">
                  {findings.map((f) => (
                    <li key={f.finding_id} className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
                      <SeverityBadge severity={f.severity} /> <span className="text-ink">{f.title}</span>
                      <span className="text-ink-faint">· {f.stance} · weight {f.weight > 0 ? "+" : ""}{f.weight}</span>
                    </li>
                  ))}
                </ul>
              )}

              {issues.length > 0 && (
                <p role="alert" className="mt-3 flex items-start gap-2 text-[12.5px] text-suspicious" data-testid="ledger-provenance-warning">
                  <ShieldAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                  Incomplete provenance: {issues.join(", ")} not returned. This event is shown as received and cannot be treated as verified evidence.
                </p>
              )}

              <p className="mt-4 text-[12.5px]">
                {inRoom ? (
                  <Link to={evidencePath(caseId, e.event_id)} className="inline-flex items-center gap-1.5 text-verified underline-offset-2 hover:underline">
                    Open in Evidence Room <ArrowUpRight size={13} aria-hidden />
                  </Link>
                ) : (
                  <span className="text-ink-faint">Not linkable: the updated case does not contain this event, so the Evidence Room could not show it.</span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
