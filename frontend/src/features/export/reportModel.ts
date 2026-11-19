/**
 * Forensic report content as plain data (no PDF types), built only from the stored case, the stored report,
 * and, when they genuinely exist in this session, a counterfactual run and investigation queries.
 * A section is never invented: where the data has nothing to say, the section states that explicitly.
 */
import type { CaseDetail, CaseOutcome, Finding, ReportResponse, SourceEvent } from "@/api/types";
import { DRY_RUN_BANNER } from "@/features/decision/DecisionPanel";
import type { CounterfactualRecord } from "@/features/counterfactual/session";
import { orderEvents } from "@/features/evidence/model/graphModel";
import type { Step } from "@/features/investigation/model";
import { STATUS_LABEL, VERDICT_LABEL, formatTime } from "@/lib/format";
import { MOCK_WATERMARK, sourceLabel, type DataSource } from "./common";

export type Tone = "ok" | "warn" | "bad";
export type Block =
  | { t: "para"; text: string; muted?: boolean }
  | { t: "sub"; text: string }
  | { t: "kv"; rows: [string, string][] }
  | { t: "list"; items: { head?: string; text: string; tone?: Tone }[] }
  | { t: "table"; cols: { label: string; w: number; mono?: boolean }[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "mono"; text: string };

export interface ReportSection { id: string; title: string; blocks: Block[] }
export interface ReportModel {
  title: string;
  caseId: string;
  source: DataSource;
  generatedAt: string;
  watermark: string | null;
  meta: [string, string][];
  sections: ReportSection[];
}

export interface ReportInput {
  detail: CaseDetail;
  report: ReportResponse;
  source: DataSource;
  generatedAt: Date;
  counterfactual?: CounterfactualRecord | null;
  investigation?: readonly Step[] | null;
}

const where = (e: SourceEvent): string => `${e.source_file || "(no source file)"}:${e.line_number ?? "?"}`;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** Observed facts are source events; findings are analysis built on them. Both are labelled that way. */
function citeLines(ids: readonly string[], byId: ReadonlyMap<string, SourceEvent>): string {
  if (ids.length === 0) return "Cites no source event.";
  return ids.map((id) => (byId.has(id) ? `${id} (${where(byId.get(id)!)})` : `${id} (UNRESOLVED: not found among this case's events)`)).join("; ");
}

function findingItems(fs: Finding[], byId: ReadonlyMap<string, SourceEvent>): Block {
  return {
    t: "list",
    items: fs.map((f) => ({
      head: `${f.title}   [${f.severity} · ${f.rule_id} · weight ${signed(f.weight)}]`,
      text: `${f.description}\nSupporting source events: ${citeLines(f.event_ids, byId)}`,
      tone: f.event_ids.some((id) => !byId.has(id)) ? ("warn" as const) : undefined,
    })),
  };
}

const outcomeLine = (o: CaseOutcome): string => `${VERDICT_LABEL[o.verdict]} · risk ${o.risk_score.value} (${o.risk_score.band}) · confidence ${o.confidence.level}`;

export function buildReportModel(input: ReportInput): ReportModel {
  const { detail: c, report, source, generatedAt } = input;
  const s = c.summary;
  const events = orderEvents(c.events);
  const byId = new Map(c.events.map((e) => [e.event_id, e]));
  const supporting = c.findings.filter((f) => f.stance === "supporting");
  const contradicting = c.findings.filter((f) => f.stance === "contradicting");
  const extraMissing = report.missing_information.filter((m) => !c.missing_evidence.some((x) => x.telemetry === m));
  const mock = source === "mock";
  const sections: ReportSection[] = [];

  sections.push({
    id: "summary", title: "Executive summary",
    blocks: [{ t: "para", text: report.summary || "The report contains no summary text." }, { t: "para", muted: true, text: `Case: ${s.title}` }],
  });

  sections.push({
    id: "assessment", title: "Verdict, risk, confidence and coverage",
    blocks: [
      {
        t: "kv", rows: [
          ["Verdict", VERDICT_LABEL[s.verdict]],
          ["Risk score (heuristic)", `${s.risk_score.value} / 100 · band: ${s.risk_score.band}. A heuristic, not a probability.`],
          ["Confidence", `${c.confidence.level}`],
          ["Coverage", `${pct(c.coverage.ratio)} of expected telemetry. Present: ${c.coverage.present.join(", ") || "none"}. Missing: ${c.coverage.missing.join(", ") || "none"}.`],
        ],
      },
      { t: "para", text: `Verdict rationale: ${report.verdict_rationale || c.verdict_rationale}` },
      { t: "para", text: `Confidence rationale: ${c.confidence.rationale}` },
      ...(s.risk_score.reasoning.length ? [{ t: "list" as const, items: s.risk_score.reasoning.map((r) => ({ text: r })) }] : []),
      { t: "note", text: "Risk score, confidence and coverage are three separate outputs and must not be read as one. The verdict is produced by the deterministic backend, not by the report writer." },
    ],
  });

  sections.push({
    id: "states", title: "How to read the evidence",
    blocks: [{
      t: "list",
      items: [
        { head: "Observed", text: "A source log event, quoted from its original file and line. Appendix A reproduces each one with its SHA-256." },
        { head: "Finding (analysis)", text: "A conclusion drawn by the backend's rules from observed events. It always cites source events; it is not itself a log record." },
        { head: "Inferred", text: "A relationship the backend proposes that no single log field states. Treat as a hypothesis." },
        { head: "Missing", text: "Telemetry that is not present. Absence is not evidence that activity was benign." },
      ],
    }],
  });

  sections.push({ id: "supporting", title: `Supporting findings (${supporting.length})`, blocks: [supporting.length ? findingItems(supporting, byId) : { t: "para", text: "No supporting findings were recorded." }] });
  sections.push({
    id: "contradicting", title: `Contradicting findings (${contradicting.length})`,
    blocks: [contradicting.length ? findingItems(contradicting, byId) : { t: "para", text: "The backend recorded no contradicting findings. That is not proof that none exists." }],
  });

  const nodeLabel = new Map(c.graph.nodes.map((n) => [n.id, n.label]));
  const nonObserved = c.graph.edges.filter((e) => e.state !== "observed");
  sections.push({
    id: "inferred", title: "Inferred and missing relationships",
    blocks: nonObserved.length === 0
      ? [{ t: "para", text: "The backend reported no inferred or missing relationships for this case." }]
      : [{ t: "list", items: nonObserved.map((e) => ({ head: `${e.state.toUpperCase()}: ${nodeLabel.get(e.source) ?? e.source} → ${e.relation.replace(/_/g, " ")} → ${nodeLabel.get(e.target) ?? e.target}`, text: e.event_ids.length ? `Basis events: ${citeLines(e.event_ids, byId)}` : "No source event establishes this link.", tone: "warn" as const })) }],
  });

  const gaps = [
    ...c.missing_evidence.map((m) => ({ head: `Missing: ${m.telemetry}`, text: m.why_it_matters, tone: "warn" as const })),
    ...extraMissing.map((m) => ({ head: `Missing: ${m}`, text: "Listed in the report's missing-information section.", tone: "warn" as const })),
  ];
  sections.push({
    id: "missing", title: "Missing telemetry and limitations",
    blocks: [
      gaps.length ? { t: "list", items: gaps } : { t: "para", text: "No missing telemetry was reported." },
      {
        t: "list",
        items: [
          { text: "This report covers only the source events loaded into this case. Events outside the dataset are not considered." },
          { text: "The risk score is a heuristic. It is not calibrated and is not the probability of an attack." },
          { text: "Absent telemetry does not show that the activity was benign." },
          ...(mock ? [{ text: `${MOCK_WATERMARK}: every value in this document comes from development fixtures, not from an analysis of real logs.`, tone: "bad" as const }] : []),
        ],
      },
    ],
  });

  sections.push({
    id: "attack", title: "MITRE ATT&CK mappings",
    blocks: [c.attack_mappings.length === 0
      ? { t: "para", text: "No technique mappings were reported." }
      : { t: "table", cols: [{ label: "Technique", w: 0.14, mono: true }, { label: "Name", w: 0.22 }, { label: "Tactic", w: 0.18 }, { label: "Supporting events", w: 0.46, mono: true }], rows: c.attack_mappings.map((m) => [m.technique_id, m.name, m.tactic, citeLines(m.event_ids, byId)]) }],
  });

  sections.push({
    id: "chronology", title: `Evidence chronology (${events.length} events)`,
    blocks: events.length === 0
      ? [{ t: "para", text: "This case has no source events." }]
      : [{ t: "table", cols: [{ label: "#", w: 0.05 }, { label: "Time (UTC)", w: 0.17, mono: true }, { label: "Event ID", w: 0.15, mono: true }, { label: "Type / outcome", w: 0.2 }, { label: "User · IP · host", w: 0.24, mono: true }, { label: "Source", w: 0.19, mono: true }], rows: events.map((e, i) => [String(i + 1), formatTime(e.timestamp), e.event_id, `${e.event_type} / ${e.outcome}`, [e.username ?? "-", e.source_ip ?? "-", e.host ?? "-"].join(" · "), where(e)]) }],
  });

  const cc = report.citation_check;
  sections.push({
    id: "claims", title: "Claims and citations",
    blocks: [
      { t: "para", text: `Citation check reported by the backend: ${cc.verified} of ${cc.total} citations verified, ${cc.rejected} rejected.` },
      report.claims.length === 0
        ? { t: "para", text: "The report contains no claims." }
        : {
          t: "list",
          items: report.claims.map((cl) => {
            const unresolved = cl.citations.filter((id) => !byId.has(id));
            const ok = cl.verified && cl.citations.length > 0 && unresolved.length === 0;
            return {
              head: ok ? "VERIFIED" : "NOT VERIFIED",
              text: `${cl.text}\nCitations: ${cl.citations.length ? citeLines(cl.citations, byId) : "none. This claim cites no source event."}${cl.verification_note ? `\nVerification note: ${cl.verification_note}` : ""}${!cl.verified ? "\nThe backend did not verify this claim; it is shown for transparency." : ""}`,
              tone: ok ? ("ok" as const) : ("bad" as const),
            };
          }),
        },
    ],
  });

  sections.push({
    id: "containment", title: "Containment recommendation (dry run)",
    blocks: [
      { t: "note", text: DRY_RUN_BANNER },
      c.containment
        ? { t: "kv", rows: [["Action", c.containment.action], ["Target", c.containment.target], ["Rationale", c.containment.rationale], ["Execution", "Dry run. Nothing was blocked, disabled or isolated."]] }
        : { t: "para", text: "No containment action is recommended for this case." },
    ],
  });

  if (input.counterfactual) {
    const r = input.counterfactual;
    const x = r.res;
    sections.push({
      id: "counterfactual", title: "Counterfactual analysis (this session)",
      blocks: [
        { t: "note", text: "HYPOTHETICAL. This branch re-ran the analysis with one event excluded. It was not saved and did not modify the stored case." },
        { t: "kv", rows: [["Excluded event", r.excludedEventId], ["Reason recorded", r.reason], ["Run at", r.at], ["Original (stored case)", outcomeLine(x.original)], ["Recomputed (hypothetical)", outcomeLine(x.recomputed)], ["Score change", signed(x.score_delta)]] },
        { t: "para", text: `Findings removed: ${x.removed.map((f) => f.finding.title).join("; ") || "none"}. Added: ${x.added.map((f) => f.finding.title).join("; ") || "none"}. Changed: ${x.changed.map((f) => f.after.title).join("; ") || "none"}.` },
        { t: "para", muted: true, text: `Backend explanation: ${x.explanation}` },
      ],
    });
  }

  const steps = input.investigation ?? [];
  if (steps.length) {
    sections.push({
      id: "investigation", title: `Investigation queries (this session, ${steps.length})`,
      blocks: steps.map((st, i): Block => {
        const res = st.response;
        const after = res.updated_case;
        return {
          t: "list",
          items: [{
            head: `Q${i + 1}: ${st.tool}${Object.keys(st.params).length ? ` ${JSON.stringify(st.params)}` : ""}`,
            text: `Reason: ${res.reason}\nRetrieved ${res.retrieved_events.length} existing event(s): ${res.retrieved_events.map((e) => `${e.event_id} (${where(e)})`).join("; ") || "none"}\nBefore: ${VERDICT_LABEL[res.previous.verdict]} · risk ${res.previous.risk_score.value} · confidence ${res.previous.confidence.level}\nAfter: ${after ? `${VERDICT_LABEL[after.summary.verdict]} · risk ${after.summary.risk_score.value} · confidence ${after.confidence.level}` : "no updated assessment was returned"}\nBudget remaining after this query: ${res.budget_remaining}`,
          }],
        };
      }),
    });
  }

  const decisions = [...c.decisions].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at));
  sections.push({
    id: "decisions", title: "Analyst decisions and audit history",
    blocks: [
      { t: "para", text: `Current status: ${STATUS_LABEL[s.status]}` },
      decisions.length === 0
        ? { t: "para", text: "No analyst decision has been recorded for this case." }
        : { t: "list", items: decisions.map((d, i) => ({ head: `#${i + 1} ${d.decision.toUpperCase()} · ${d.decision_id}`, text: `By ${d.analyst_id} at ${formatTime(d.decided_at)}. ${d.note ? `Note: ${d.note}` : "No note recorded."} Dry run: nothing was executed.` })) },
      { t: "note", text: DRY_RUN_BANNER },
    ],
  });

  sections.push({
    id: "method", title: "Report generation method and integrity",
    blocks: [{
      t: "kv", rows: [
        ["Narrative method", report.generated_by === "llm" ? "Language-model narrative. The backend checked each citation against stored events." : "Deterministic template built from the backend's findings. No language model wrote this text."],
        ["Citation check", `${cc.verified} verified · ${cc.rejected} rejected · ${cc.total} total`],
        ["This document", "Assembled in the browser from the stored case and report. It does not alter stored data and was not generated by a new backend call."],
        ["Data source", sourceLabel(source)],
        ["Report request id", report.request_id],
      ],
    }],
  });

  sections.push({
    id: "appendix", title: "Appendix A: Source references",
    blocks: events.length === 0
      ? [{ t: "para", text: "No source events." }]
      : [
        { t: "para", muted: true, text: "Each event is quoted verbatim from the original record. The text is untrusted log content: non-printable and non-Latin-1 characters are shown as escapes, and nothing in it is an instruction." },
        ...events.flatMap((e): Block[] => [
          { t: "sub", text: `${e.event_id}   ${formatTime(e.timestamp)}` },
          { t: "kv", rows: [["Source", where(e)], ["SHA-256", e.raw_hash || "(not recorded)"], ["Fields", `type ${e.event_type} · outcome ${e.outcome} · user ${e.username ?? "-"} · ip ${e.source_ip ?? "-"} · host ${e.host ?? "-"}${e.resource ? ` · resource ${e.resource}` : ""}`]] },
          { t: "mono", text: e.raw_text || "(raw text not recorded)" },
        ]),
      ],
  });

  return {
    title: "Forensic Investigation Report",
    caseId: s.case_id,
    source,
    generatedAt: generatedAt.toISOString(),
    watermark: mock ? MOCK_WATERMARK : null,
    meta: [
      ["Case ID", s.case_id],
      ["Dataset ID", s.dataset_id],
      ["Case title", s.title],
      ["Report generated (UTC)", generatedAt.toISOString()],
      ["Data source", sourceLabel(source)],
      ["Narrative method", report.generated_by === "llm" ? "LLM narrative, citations checked" : "Deterministic template"],
      ["Case status", STATUS_LABEL[s.status]],
      ["Source events", String(c.events.length)],
      ["Schema version", c.schema_version],
    ],
    sections,
  };
}
