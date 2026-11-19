import { useCallback, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText, Image as ImageIcon, LoaderCircle, TriangleAlert, Check } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseDetail, ReportResponse } from "@/api/types";
import { Chip } from "@/components/ui/Chip";
import { lastCounterfactual } from "@/features/counterfactual/session";
import { buildGraph, orderEvents } from "@/features/evidence/model/graphModel";
import { computeLayout } from "@/features/evidence/model/layout";
import { sessionSteps } from "@/features/investigation/model";
import { config } from "@/lib/config";
import { ARTIFACT_EXT, MOCK_WATERMARK, downloadBlob, exportFilename, formatBytes, stamp, type ArtifactKind, type DataSource } from "./common";
import { csvBlob, decisionsCsv, eventsCsv, findingsCsv } from "./csv";
import { exportGraphPng, timesOf } from "./graphPng";
import { renderReportPdf } from "./pdf";
import { buildReportModel } from "./reportModel";

export interface Availability { available: boolean; reason: string | null }

/** Pure: which artifacts can be produced from this case, and why not when they cannot. */
export function exportAvailability(c: CaseDetail): Record<ArtifactKind, Availability> {
  const yes: Availability = { available: true, reason: null };
  const g = buildGraph(c);
  return {
    report: yes,
    events: c.events.length > 0 ? yes : { available: false, reason: "This case has no source events to export." },
    findings: c.findings.length > 0 ? yes : { available: false, reason: "This case has no findings to export." },
    decisions: c.decisions.length > 0 ? yes : { available: false, reason: "No analyst decision has been recorded yet, so there is no audit history to export." },
    graph: g.nodes.length > 0 ? yes : { available: false, reason: "There is no evidence graph to draw for this case." },
  };
}

const META: Record<ArtifactKind, { title: string; format: string; blurb: string; Icon: typeof FileText }> = {
  report: { title: "Forensic investigation report", format: "PDF", blurb: "Summary, separate verdict / risk / confidence / coverage, findings, chronology, citations, ATT&CK, decisions and a source appendix. Text is selectable.", Icon: FileText },
  events: { title: "Source events", format: "CSV", blurb: "One row per event with stable ID, timestamp, source file, line, SHA-256 and the raw record.", Icon: FileSpreadsheet },
  findings: { title: "Findings", format: "CSV", blurb: "One row per finding with stance, weight, cited event IDs and file:line references.", Icon: FileSpreadsheet },
  decisions: { title: "Analyst decision audit", format: "CSV", blurb: "Every recorded decision, oldest first, with analyst, time, note and the dry-run flag.", Icon: FileSpreadsheet },
  graph: { title: "Evidence constellation", format: "PNG", blurb: "The whole graph at high resolution with labels, legend, case ID and export time.", Icon: ImageIcon },
};
const ORDER: ArtifactKind[] = ["report", "events", "findings", "decisions", "graph"];

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done"; name: string; size: number } | { kind: "error"; message: string };

export function ExportPanel({ detail, getReport, compact = false }: {
  detail: CaseDetail;
  /** Returns the stored report. The Report page already has it; the Evidence Room fetches it on demand. */
  getReport?: () => Promise<ReportResponse>;
  compact?: boolean;
}) {
  const caseId = detail.summary.case_id;
  const source: DataSource = config.useMocks ? "mock" : "live";
  const avail = useMemo(() => exportAvailability(detail), [detail]);
  const [status, setStatus] = useState<Record<ArtifactKind, Status>>({ report: { kind: "idle" }, events: { kind: "idle" }, findings: { kind: "idle" }, decisions: { kind: "idle" }, graph: { kind: "idle" } });
  const [announce, setAnnounce] = useState("");
  const lock = useRef(false); // one export at a time
  const recent = useRef<{ kind: ArtifactKind; at: number } | null>(null); // a quick repeat click on the same item is a duplicate

  const cf = lastCounterfactual(caseId);
  const steps = sessionSteps(caseId);

  const set = (k: ArtifactKind, s: Status) => setStatus((p) => ({ ...p, [k]: s }));

  const run = useCallback(async (kind: ArtifactKind) => {
    if (lock.current || !avail[kind].available) return;
    const now = Date.now();
    if (recent.current && recent.current.kind === kind && now - recent.current.at < 1000) return;
    recent.current = { kind, at: now };
    lock.current = true;
    set(kind, { kind: "busy" });
    setAnnounce(`Preparing ${META[kind].title}…`);
    const at = new Date();
    const name = exportFilename({ caseId, kind, source, at });
    try {
      let blob: Blob;
      if (kind === "report") {
        const report = await (getReport ?? (() => api.getReport(caseId)))();
        const model = buildReportModel({ detail, report, source, generatedAt: at, counterfactual: lastCounterfactual(caseId), investigation: sessionSteps(caseId) });
        blob = (await renderReportPdf(model)).blob;
      } else if (kind === "events") blob = csvBlob(eventsCsv(detail, source));
      else if (kind === "findings") blob = csvBlob(findingsCsv(detail, source));
      else if (kind === "decisions") blob = csvBlob(decisionsCsv(detail, source));
      else {
        const g = buildGraph(detail);
        const layout = computeLayout(g, orderEvents(detail.events).map((e) => e.event_id));
        const r = await exportGraphPng(g, layout, { caseId, source, exportedAt: at, timeOf: timesOf(detail.events) });
        if (!r.ok) throw new Error(r.reason);
        blob = r.blob;
      }
      if (blob.size === 0) throw new Error("The file came out empty, so it was not downloaded.");
      downloadBlob(blob, name);
      set(kind, { kind: "done", name, size: blob.size });
      setAnnounce(`${META[kind].title} downloaded as ${name}, ${formatBytes(blob.size)}.`);
    } catch (e) {
      const message = e instanceof ApiError ? `${e.message} (the report could not be read)` : e instanceof Error ? e.message : "The export failed.";
      recent.current = null; // a failed attempt may be retried straight away
      set(kind, { kind: "error", message });
      setAnnounce(`${META[kind].title} failed: ${message}`);
    } finally {
      lock.current = false;
    }
  }, [avail, caseId, detail, getReport, source]);

  const busy = ORDER.some((k) => status[k].kind === "busy");

  return (
    <div data-testid="export-panel">
      <div className="flex flex-wrap items-center gap-2.5">
        {source === "mock"
          ? <Chip dashed title="Every file is marked as a development fixture.">Exports are development fixtures</Chip>
          : <Chip tone="mint" dot>Live data</Chip>}
        <Chip title="Exports are read-only copies. Nothing stored is changed.">Read-only</Chip>
      </div>
      {source === "mock" && (
        <p className="mt-3 max-w-[64ch] text-[12.5px] leading-relaxed text-suspicious" data-testid="export-mock-note">
          Files are labelled “{MOCK_WATERMARK}”: the PDF and PNG are watermarked, CSV rows carry <span className="font-mono">data_source=mock</span>, and filenames start with <span className="font-mono">DEVFIXTURE_</span>. Nothing here is a real investigation.
        </p>
      )}

      <ul className={`mt-6 divide-y divide-line ${compact ? "" : "border-y border-line"}`} aria-label="Exportable artifacts">
        {ORDER.map((k) => {
          const m = META[k];
          const a = avail[k];
          const s = status[k];
          const Icon = m.Icon;
          const name = exportFilename({ caseId, kind: k, source, at: new Date(0) }).replace(stamp(new Date(0)), "<UTC time>");
          return (
            <li key={k} className="py-5" data-testid={`export-${k}`} data-available={a.available}>
              <div className={`grid gap-x-6 gap-y-3 ${compact ? "" : "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Icon size={16} aria-hidden className={a.available ? "text-verified" : "text-ink-faint"} />
                    <h3 className="text-[14.5px] font-medium text-ink">{m.title}</h3>
                    <span className="border border-line-strong px-1.5 py-0.5 font-mono text-[10.5px] tracking-wider text-ink-muted">{m.format}</span>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{m.blurb}</p>
                  <p className="mt-1.5 break-all font-mono text-[11px] text-ink-faint" data-testid={`export-${k}-name`}>{name}</p>
                  {k === "report" && (
                    <p className="mt-1.5 text-[12px] text-ink-faint" data-testid="export-report-includes">
                      {cf || steps.length
                        ? `Also includes, from this session: ${[cf ? "a counterfactual run" : "", steps.length ? `${steps.length} investigation ${steps.length === 1 ? "query" : "queries"}` : ""].filter(Boolean).join(" and ")}.`
                        : "No counterfactual or investigation results exist in this session, so those sections are left out rather than invented."}
                    </p>
                  )}
                  {k === "graph" && <p className="mt-1.5 text-[12px] text-ink-faint">Shows the full investigation, not the current replay position or zoom.</p>}
                  {!a.available && <p className="mt-2 text-[12.5px] text-suspicious" id={`export-${k}-why`} data-testid={`export-${k}-why`}>{a.reason}</p>}
                </div>
                <div className="sm:text-right">
                  <button
                    type="button" onClick={() => void run(k)} disabled={!a.available || busy}
                    aria-describedby={!a.available ? `export-${k}-why` : undefined}
                    aria-label={`Download ${m.title} as ${m.format}`}
                    className="inline-flex min-w-[148px] items-center justify-center gap-2 border border-verified/55 px-4 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/10 disabled:cursor-not-allowed disabled:border-line-strong disabled:text-ink-faint disabled:hover:bg-transparent"
                  >
                    {s.kind === "busy" ? <LoaderCircle size={13} aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Download size={13} aria-hidden />}
                    {s.kind === "busy" ? "Preparing…" : `.${ARTIFACT_EXT[k]}`}
                  </button>
                </div>
              </div>
              {s.kind === "done" && <p className="mt-3 flex items-start gap-2 text-[12.5px] text-verified" data-testid={`export-${k}-done`}><Check size={14} aria-hidden className="mt-0.5 shrink-0" />Downloaded <span className="break-all font-mono">{s.name}</span> · {formatBytes(s.size)}</p>}
              {s.kind === "error" && <p role="alert" className="mt-3 flex items-start gap-2 text-[12.5px] text-critical" data-testid={`export-${k}-error`}><TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />{s.message} You can try again.</p>}
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <p className="mt-5 max-w-[68ch] text-[12px] leading-relaxed text-ink-faint">
        A combined ZIP package with a manifest and checksums is not available yet. Each file is a read-only copy of stored data; log content in every file is untrusted and is escaped or neutralised so it cannot run as a formula or markup.
      </p>
    </div>
  );
}

