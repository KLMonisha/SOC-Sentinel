import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Check, TriangleAlert, X } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseDetail, Finding, ReportResponse } from "@/api/types";
import { VerdictLabel } from "@/components/ui/Badges";
import { Chip } from "@/components/ui/Chip";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { Readout } from "@/components/ui/Readout";
import { Surface } from "@/components/ui/Surface";
import { DecisionPanel, DRY_RUN_BANNER } from "@/features/decision/DecisionPanel";
import { ExportPanel } from "@/features/export/ExportPanel";
import { orderEvents } from "@/features/evidence/model/graphModel";
import { CitationChip } from "@/features/report/CitationChip";
import { evidencePath, resolveCitations } from "@/features/report/citations";
import { config } from "@/lib/config";
import { STATUS_LABEL, formatTime } from "@/lib/format";

type Load =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError | Error }
  | { kind: "ready"; report: ReportResponse; detail: CaseDetail };

const SECTIONS = [
  ["summary", "Executive summary"],
  ["verdict", "Verdict and confidence"],
  ["supporting", "Supporting evidence"],
  ["contradicting", "Contradicting evidence"],
  ["missing", "Missing telemetry"],
  ["attack", "MITRE ATT&CK"],
  ["chronology", "Chronology"],
  ["containment", "Containment"],
  ["claims", "Claims and citations"],
  ["decision", "Analyst decision and audit"],
  ["export", "Export investigation"],
] as const;

function Section({ id, n, title, children }: { id: string; n: number; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6">
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[12px] text-verified">{String(n).padStart(2, "0")}</span>
        <h2 id={`${id}-h`} className="t-micro text-ink">{title}</h2>
        <span className="hairline ml-2 hidden flex-1 sm:block" aria-hidden />
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Cites({ caseId, ids, known }: { caseId: string; ids: string[]; known: ReadonlySet<string> }) {
  const { resolved, unresolved } = resolveCitations(ids, known);
  return (
    <span className="flex flex-wrap gap-1.5">
      {resolved.map((id) => <CitationChip key={id} caseId={caseId} eventId={id} resolved />)}
      {unresolved.map((id) => <CitationChip key={id} caseId={caseId} eventId={id} resolved={false} />)}
    </span>
  );
}

function FindingList({ findings, caseId, known, empty }: { findings: Finding[]; caseId: string; known: ReadonlySet<string>; empty: string }) {
  if (findings.length === 0) return <p className="text-[14px] text-ink-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {findings.map((f) => (
        <li key={f.finding_id} className="mat-plane px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-[15px] font-medium text-ink">{f.title}</h3>
            <span className="font-mono text-[11.5px] text-ink-faint">{f.rule_id} · weight {f.weight > 0 ? "+" : ""}{f.weight} · {f.severity}</span>
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{f.description}</p>
          <div className="mt-3"><Cites caseId={caseId} ids={f.event_ids} known={known} /></div>
        </li>
      ))}
    </ul>
  );
}

export function ReportPage() {
  const { caseId = "" } = useParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    try {
      // Reports are generated and stored by the backend; this only reads them.
      const [report, detail] = await Promise.all([api.getReport(caseId, signal), api.getCase(caseId, signal)]);
      setLoad({ kind: "ready", report, detail });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setLoad({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading the report.") });
    }
  }, [caseId]);

  // After a decision only the case changes (status and audit history); the stored report is not re-read.
  const refreshCase = useCallback(async () => {
    const detail = await api.getCase(caseId);
    setLoad((prev) => (prev.kind === "ready" ? { ...prev, detail } : prev));
  }, [caseId]);

  useEffect(() => {
    setLoad({ kind: "loading" });
    const ctrl = new AbortController();
    void fetchAll(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchAll]);

  const known = useMemo(() => new Set(load.kind === "ready" ? load.detail.events.map((e) => e.event_id) : []), [load]);
  const ordered = useMemo(() => (load.kind === "ready" ? orderEvents(load.detail.events) : []), [load]);

  if (load.kind === "loading") return <p role="status" className="px-6 py-10 text-[13px] text-ink-muted sm:px-14">Loading report…</p>;
  if (load.kind === "error") {
    const requestId = "requestId" in load.error ? load.error.requestId : null;
    return (
      <div role="alert" className="mx-auto mt-12 max-w-xl border border-critical/40 p-5 text-[13.5px]">
        <p className="text-critical">Could not open the report for {caseId}.</p>
        <p className="mt-1 text-ink-muted">{load.error.message}{requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {requestId}</span>}</p>
        <div className="mt-4 flex gap-3">
          <button onClick={() => { setLoad({ kind: "loading" }); void fetchAll(); }} className="border border-verified/50 px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/10">Retry</button>
          <Link to="/app" className="px-4 py-2 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">Command Center</Link>
        </div>
      </div>
    );
  }

  const { report, detail: c } = load;
  const s = c.summary;
  const supporting = c.findings.filter((f) => f.stance === "supporting");
  const contradicting = c.findings.filter((f) => f.stance === "contradicting");
  const extraMissing = report.missing_information.filter((m) => !c.missing_evidence.some((x) => x.telemetry === m));
  const rejected = report.claims.filter((x) => !x.verified).length;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-6 pb-24 pt-8 sm:px-10 lg:px-14">
      <Link to={evidencePath(s.case_id)} className="inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Evidence Room
      </Link>

      <header className="mt-6">
        <p className="t-label mb-4">Investigation report · {s.case_id} · dataset {s.dataset_id}</p>
        <DisplayTitle lines={["Investigation", "Report"]} size="text-[clamp(19px,4.2vw,62px)]" at={4} />
        <p className="mt-6 max-w-[70ch] text-[18px] leading-snug text-ink">{s.title}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {report.generated_by === "llm" ? (
            <Chip tone="mint" dot title="Narrative written by a language model; every citation was checked against stored events by the backend.">LLM narrative · citations checked</Chip>
          ) : (
            <Chip title="Deterministic template built from the backend's findings; no model wrote this text.">Template fallback · deterministic</Chip>
          )}
          {config.useMocks && <Chip dashed title="This report comes from the in-app development mock.">Development fixture · not a real analysis</Chip>}
          <Chip title="Containment is always a dry run.">Dry run only</Chip>
          <a href="#export" className="inline-flex items-center gap-2 border border-verified/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-verified hover:bg-verified/10">Export ↓</a>
        </div>
      </header>

      <div className="mt-12 grid gap-x-14 gap-y-10 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Report sections" className="hidden lg:block">
          <ol className="sticky top-6 space-y-1 border-l border-line pl-4 text-[12.5px]">
            {SECTIONS.map(([id, label], i) => (
              <li key={id}>
                <a href={`#${id}`} className="block py-1 text-ink-muted transition-colors hover:text-verified">
                  <span className="mr-2 font-mono text-[11px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>{label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="min-w-0 space-y-14">
          <Section id="summary" n={1} title="Executive summary">
            <p className="max-w-[72ch] text-[17px] leading-relaxed text-ink">{report.summary}</p>
          </Section>

          <Section id="verdict" n={2} title="Verdict and confidence">
            <Surface level="raised" brackets className="px-7 py-7">
              <div className="grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4">
                <div><div className="t-label">Verdict</div><div className="mt-3 text-[17px]"><VerdictLabel verdict={s.verdict} /></div></div>
                <Readout label="Risk (heuristic)" value={s.risk_score.value} unit="/100" size="md" hint="Not a probability" />
                <Readout label="Confidence" value={<span className="capitalize">{c.confidence.level}</span>} size="md" />
                <Readout label="Coverage" value={Math.round(c.coverage.ratio * 100)} unit="%" size="md" hint="Share of expected telemetry present" />
              </div>
              <p className="mt-6 max-w-[72ch] text-[14.5px] leading-relaxed text-ink-muted">{report.verdict_rationale}</p>
              <p className="mt-3 max-w-[72ch] text-[14px] leading-relaxed text-ink-muted"><span className="text-ink-faint">Confidence rationale: </span>{c.confidence.rationale}</p>
              <p className="mt-3 text-[12.5px] text-ink-faint">Risk score, confidence and coverage are separate outputs; the verdict is produced by the deterministic backend, not by the report writer.</p>
            </Surface>
          </Section>

          <Section id="supporting" n={3} title="Supporting evidence">
            <FindingList findings={supporting} caseId={s.case_id} known={known} empty="No supporting findings were recorded." />
          </Section>

          <Section id="contradicting" n={4} title="Contradicting evidence">
            <FindingList findings={contradicting} caseId={s.case_id} known={known} empty="The backend recorded no contradicting findings for this case. That is not proof that none exists." />
          </Section>

          <Section id="missing" n={5} title="Missing telemetry">
            {c.missing_evidence.length === 0 && extraMissing.length === 0 ? (
              <p className="text-[14px] text-ink-muted">No missing telemetry was reported.</p>
            ) : (
              <ul className="space-y-3">
                {c.missing_evidence.map((m) => (
                  <li key={m.missing_id} className="border-l-2 border-dashed border-missing pl-4">
                    <p className="text-[14.5px] text-ink">{m.telemetry} <span className="ml-2 text-[11px] uppercase tracking-wider text-missing">missing</span></p>
                    <p className="mt-1 text-[13.5px] text-ink-muted">{m.why_it_matters}</p>
                  </li>
                ))}
                {extraMissing.map((m) => (
                  <li key={m} className="border-l-2 border-dashed border-missing pl-4 text-[14.5px] text-ink">{m} <span className="ml-2 text-[11px] uppercase tracking-wider text-missing">missing</span></li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-[12.5px] text-ink-faint">Absent telemetry is not evidence that the activity was benign.</p>
          </Section>

          <Section id="attack" n={6} title="MITRE ATT&CK">
            {c.attack_mappings.length === 0 ? <p className="text-[14px] text-ink-muted">No technique mappings were reported.</p> : (
              <ul className="space-y-3">
                {c.attack_mappings.map((m) => (
                  <li key={m.technique_id} className="mat-plane px-5 py-4">
                    <p className="text-[14.5px]"><span className="font-mono text-verified">{m.technique_id}</span> {m.name} <span className="text-ink-faint">· {m.tactic}</span></p>
                    <div className="mt-3"><Cites caseId={s.case_id} ids={m.event_ids} known={known} /></div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="chronology" n={7} title="Chronology">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-y-1 text-left text-[13px]">
                <caption className="sr-only">Source events in chronological order</caption>
                <thead><tr className="t-label"><th className="px-4 py-1 font-normal">Time (UTC)</th><th className="font-normal">Event</th><th className="font-normal">Type</th><th className="font-normal">Entities</th></tr></thead>
                <tbody>
                  {ordered.map((e) => (
                    <tr key={e.event_id} className="mat-plane">
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[12px] text-ink-muted">{formatTime(e.timestamp).slice(0, 19)}</td>
                      <td className="pr-4"><CitationChip caseId={s.case_id} eventId={e.event_id} resolved /></td>
                      <td className="pr-4 text-ink-muted">{e.event_type}</td>
                      <td className="pr-4 font-mono text-[12px] text-ink-muted">{[e.username ?? "—", e.source_ip ?? "—", e.host ?? "—"].join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="containment" n={8} title="Containment">
            <p role="note" className="mb-4 inline-block border border-dashed border-ink-muted/50 px-3.5 py-2 font-mono text-[11.5px] uppercase tracking-[0.1em] text-ink">{DRY_RUN_BANNER}</p>
            {c.containment ? (
              <dl className="grid max-w-[80ch] grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-[14.5px]">
                <dt className="t-label">Action</dt><dd className="text-ink">{c.containment.action}</dd>
                <dt className="t-label">Target</dt><dd className="font-mono text-[13px] text-ink">{c.containment.target}</dd>
                <dt className="t-label">Rationale</dt><dd className="text-ink-muted">{c.containment.rationale}</dd>
              </dl>
            ) : <p className="text-[14px] text-ink-muted">No containment action is recommended for this case.</p>}
          </Section>

          <Section id="claims" n={9} title="Claims and citations">
            <p className="mb-4 max-w-[72ch] text-[13.5px] text-ink-muted" role="status">
              {report.citation_check.verified} of {report.citation_check.total} citations verified against stored events
              {report.citation_check.rejected > 0 ? `; ${report.citation_check.rejected} rejected` : ""}.
              {rejected > 0 && ` ${rejected} claim${rejected === 1 ? " is" : "s are"} not verified and shown for transparency.`}
            </p>
            <ul className="space-y-3">
              {report.claims.map((claim) => {
                const { unresolved } = resolveCitations(claim.citations, known);
                return (
                  <li key={claim.claim_id} className={`px-5 py-4 ${claim.verified && unresolved.length === 0 ? "mat-plane" : "mat-plane border border-dashed border-suspicious/50"}`}>
                    <div className="flex items-start gap-3">
                      <span className={`mt-0.5 shrink-0 ${claim.verified ? "text-verified" : "text-suspicious"}`}>
                        {claim.verified ? <Check size={15} aria-hidden /> : <X size={15} aria-hidden />}
                        <span className="sr-only">{claim.verified ? "Verified claim" : "Unverified claim"}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14.5px] leading-relaxed text-ink">{claim.text}</p>
                        {claim.verification_note && <p className="mt-1.5 text-[12.5px] text-suspicious">{claim.verification_note}</p>}
                        <div className="mt-3">
                          {claim.citations.length === 0
                            ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-suspicious"><TriangleAlert size={12} aria-hidden /> This claim cites no source event.</span>
                            : <Cites caseId={s.case_id} ids={claim.citations} known={known} />}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section id="decision" n={10} title="Analyst decision and audit">
            <p className="mb-5 text-[13.5px] text-ink-muted">Current status: <span className="text-ink">{STATUS_LABEL[s.status]}</span></p>
            <Surface level="plane" className="px-6 py-6 sm:px-8">
              <DecisionPanel caseDetail={c} onDecided={refreshCase} />
            </Surface>
            <Link to={`/app/investigation/${encodeURIComponent(s.case_id)}`} className="mt-8 mr-8 inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
              Investigate missing evidence <ArrowUpRight size={13} aria-hidden />
            </Link>
            <Link to={evidencePath(s.case_id)} className="mt-8 inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-verified hover:underline">
              Back to the Evidence Room <ArrowUpRight size={13} aria-hidden />
            </Link>
          </Section>

          <Section id="export" n={11} title="Export investigation">
            <p className="mb-6 max-w-[68ch] text-[14px] leading-relaxed text-ink-muted">Download this case as professional, evidence-grounded artifacts. Each file is produced in your browser from the stored case and report; nothing is sent anywhere.</p>
            <ExportPanel detail={c} getReport={async () => report} />
          </Section>
        </article>
      </div>
    </div>
  );
}
