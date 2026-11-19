import { describe, expect, test } from "vitest";
import { ambiguousCase, bruteForceCase, bruteForceReport, ev } from "@/api/mocks/fixtures";
import type { CaseDetail, ReportResponse } from "@/api/types";
import { buildGraph, orderEvents } from "@/features/evidence/model/graphModel";
import { computeLayout } from "@/features/evidence/model/layout";
import { MOCK_WATERMARK, exportFilename, safeSegment, stamp } from "./common";
import { DECISION_COLUMNS, EVENT_COLUMNS, FINDING_COLUMNS, csvCell, decisionsCsv, eventsCsv, findingsCsv, neutralize, toCsv } from "./csv";
import { MAX_PIXELS, drawPlan, planGraphExport, timesOf, type GraphPlan } from "./graphPng";
import { breakLong, pdfSafe, renderReportPdf } from "./pdf";
import { buildReportModel } from "./reportModel";

const clone = <T,>(x: T): T => structuredClone(x);
const NOW = new Date("2026-11-19T10:15:00.000Z");

/** Minimal CSV reader (quoted fields, doubled quotes, CRLF) to prove the output round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  return rows;
}

/** Text drawn into an uncompressed jsPDF stream: everything inside (...) Tj / [...] TJ. */
function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  for (const m of raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(m[1]!.replace(/\\([()\\])/g, "$1"));
  return out.join("\n");
}
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("filenames", () => {
  test("mock artifacts are unmistakable; case ids are sanitised", () => {
    const mock = exportFilename({ caseId: "case_bf", kind: "report", source: "mock", at: NOW });
    expect(mock).toBe("DEVFIXTURE_soc-sentinel_case_bf_20261119T101500Z_report.pdf");
    expect(exportFilename({ caseId: "case_bf", kind: "graph", source: "live", at: NOW })).toBe("soc-sentinel_case_bf_20261119T101500Z_graph.png");
    expect(safeSegment("../../etc/pass wd;rm -rf")).toBe("etc_pass_wd_rm_-rf");
    expect(stamp(NOW)).toBe("20261119T101500Z");
  });
});

describe("CSV safety and format", () => {
  test.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tTAB", "\rCR", '=HYPERLINK("http://x","y")'])("neutralises formula prefix %j", (v) => {
    expect(neutralize(v).startsWith("'")).toBe(true);
    expect(csvCell(v)).toBe(`"${("'" + v).replace(/"/g, '""')}"`);
  });
  test("ordinary text, ids and timestamps are untouched; numbers stay numbers; null is empty", () => {
    expect(neutralize("evt_0001")).toBe("evt_0001");
    expect(csvCell("2026-11-18T10:00:00Z")).toBe('"2026-11-18T10:00:00Z"');
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(true)).toBe('"true"');
  });
  test("quotes, commas and newlines survive a round trip", () => {
    const csv = toCsv(["a", "b"], [['he said "hi", ok', "line1\nline2"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.includes("\r\n")).toBe(true);
    expect(parseCsv(csv)).toEqual([["a", "b"], ['he said "hi", ok', "line1\nline2"]]);
  });
});

describe("events CSV", () => {
  test("explicit headers, one row per event, deterministic chronological order, provenance kept", () => {
    const csv = eventsCsv(bruteForceCase, "mock");
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...EVENT_COLUMNS]);
    expect(rows).toHaveLength(bruteForceCase.events.length + 1);
    expect(rows.every((r) => r.length === EVENT_COLUMNS.length)).toBe(true);
    const col = (n: (typeof EVENT_COLUMNS)[number]) => EVENT_COLUMNS.indexOf(n);
    expect(rows.slice(1).map((r) => r[col("event_id")])).toEqual(orderEvents(bruteForceCase.events).map((e) => e.event_id));
    const first = rows[1]!;
    expect(first[col("data_source")]).toBe("mock");
    expect(first[col("source_file")]).toBe("auth_logs.csv");
    expect(first[col("line_number")]).toBe("2");
    expect(first[col("raw_sha256")]).toMatch(/^[0-9a-f]{64}$/);
    expect(first[col("cited_by_findings")]).toBe("f_bf");
    expect(eventsCsv(bruteForceCase, "mock")).toBe(csv); // deterministic
  });
  test("untrusted log content cannot become a formula, and missing fields are listed rather than dropped", () => {
    const c = clone(bruteForceCase);
    c.events[0] = { ...c.events[0]!, username: "=cmd|' /C calc'!A0", raw_text: '@SUM(1,1)+"x"', resource: null, host: null };
    const rows = parseCsv(eventsCsv(c, "live"));
    const col = (n: (typeof EVENT_COLUMNS)[number]) => EVENT_COLUMNS.indexOf(n);
    const r = rows.find((x) => x[col("event_id")] === c.events[0]!.event_id)!;
    expect(r[col("username")]).toBe("'=cmd|' /C calc'!A0");
    expect(r[col("raw_text")]).toBe("'@SUM(1,1)+\"x\"");
    expect(r[col("host")]).toBe("");
    expect(r[col("missing_fields")]).toBe("host;resource");
    expect(r[col("data_source")]).toBe("live");
  });
  test("partial data: a case with no events still yields a valid header-only file", () => {
    const c = clone(bruteForceCase);
    c.events = [];
    expect(parseCsv(eventsCsv(c, "mock"))).toEqual([[...EVENT_COLUMNS]]);
  });
});

describe("findings and decisions CSV", () => {
  test("findings keep id, stance, weight, citations and source references; supporting first", () => {
    const rows = parseCsv(findingsCsv(bruteForceCase, "mock"));
    expect(rows[0]).toEqual([...FINDING_COLUMNS]);
    const col = (n: (typeof FINDING_COLUMNS)[number]) => FINDING_COLUMNS.indexOf(n);
    expect(rows.slice(1).map((r) => r[col("stance")])).toEqual(["supporting", "supporting", "supporting", "contradicting"]);
    const contra = rows.at(-1)!;
    expect(contra[col("weight")]).toBe("-5");
    expect(contra[col("source_references")]).toBe("auth_logs.csv:9");
    expect(rows[1]![col("event_ids")]).toContain("evt_0001;");
  });
  test("a finding citing an event that is not in the case is flagged, not dropped", () => {
    const c = clone(bruteForceCase);
    c.findings[0] = { ...c.findings[0]!, event_ids: [...c.findings[0]!.event_ids, "evt_ghost"] };
    const rows = parseCsv(findingsCsv(c, "live"));
    const col = (n: (typeof FINDING_COLUMNS)[number]) => FINDING_COLUMNS.indexOf(n);
    const r = rows.find((x) => x[col("finding_id")] === c.findings[0]!.finding_id)!;
    expect(r[col("unresolved_event_ids")]).toBe("evt_ghost");
    expect(r[col("event_ids")]).toContain("evt_ghost");
  });
  test("decisions are ordered oldest first, keep dry_run and flag a missing note", () => {
    const c = clone(bruteForceCase);
    c.decisions = [
      { decision_id: "d2", case_id: "case_bf", decision: "reject", analyst_id: "b", note: null, decided_at: "2026-11-19T10:05:00Z", dry_run: true },
      { decision_id: "d1", case_id: "case_bf", decision: "approve", analyst_id: "=a", note: "ok", decided_at: "2026-11-19T10:00:00Z", dry_run: true },
    ];
    const rows = parseCsv(decisionsCsv(c, "mock"));
    expect(rows[0]).toEqual([...DECISION_COLUMNS]);
    const col = (n: (typeof DECISION_COLUMNS)[number]) => DECISION_COLUMNS.indexOf(n);
    expect(rows.slice(1).map((r) => r[col("decision_id")])).toEqual(["d1", "d2"]);
    expect(rows[1]![col("analyst_id")]).toBe("'=a");
    expect(rows[2]![col("missing_fields")]).toBe("note");
    expect(rows[2]![col("dry_run")]).toBe("true");
  });
});

describe("report model", () => {
  const base = { detail: bruteForceCase, report: bruteForceReport, source: "mock" as const, generatedAt: NOW };
  const titles = (m: ReturnType<typeof buildReportModel>) => m.sections.map((s) => s.id);

  test("contains every required section, with separate verdict/risk/confidence/coverage", () => {
    const m = buildReportModel(base);
    expect(titles(m)).toEqual(expect.arrayContaining(["summary", "assessment", "supporting", "contradicting", "missing", "attack", "chronology", "claims", "containment", "decisions", "method", "appendix"]));
    const kv = m.sections.find((s) => s.id === "assessment")!.blocks.find((b) => b.t === "kv")!;
    expect(kv.t === "kv" && kv.rows.map((r) => r[0])).toEqual(["Verdict", "Risk score (heuristic)", "Confidence", "Coverage"]);
    expect(m.meta.find((r) => r[0] === "Case ID")![1]).toBe("case_bf");
    expect(m.meta.find((r) => r[0] === "Report generated (UTC)")![1]).toBe(NOW.toISOString());
  });
  test("counterfactual and investigation sections appear only when they genuinely exist", () => {
    expect(titles(buildReportModel(base))).not.toContain("counterfactual");
    expect(titles(buildReportModel(base))).not.toContain("investigation");
    const cf = { res: { original: { verdict: "likely_malicious", risk_score: { value: 70, band: "high", reasoning: [] }, confidence: { level: "medium", rationale: "" }, findings: [], graph: { nodes: [], edges: [] } }, recomputed: { verdict: "needs_investigation", risk_score: { value: 45, band: "investigate", reasoning: [] }, confidence: { level: "low", rationale: "" }, findings: [], graph: { nodes: [], edges: [] } }, score_delta: -25, added: [], removed: [], changed: [], explanation: "x", case_id: "case_bf", schema_version: "1.0", request_id: "r" }, excludedEventId: "evt_0007", reason: "test", at: "t" } as never;
    const m = buildReportModel({ ...base, counterfactual: cf });
    expect(titles(m)).toContain("counterfactual");
    expect(JSON.stringify(m.sections.find((s) => s.id === "counterfactual"))).toContain("HYPOTHETICAL");
  });
  test("unverified claims and unresolved citations are stated explicitly, never hidden", () => {
    const report: ReportResponse = clone(bruteForceReport);
    report.claims.push({ claim_id: "cx", text: "Fabricated claim", citations: ["evt_ghost"], verified: false, verification_note: "No such event" });
    report.claims.push({ claim_id: "cy", text: "Uncited claim", citations: [], verified: true, verification_note: null });
    const text = JSON.stringify(buildReportModel({ ...base, report }).sections.find((s) => s.id === "claims"));
    expect(text).toContain("NOT VERIFIED");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("cites no source event");
    expect(text).toContain("VERIFIED");
  });
  test("missing data produces an explicit statement, not an invented section", () => {
    const c: CaseDetail = clone(ambiguousCase);
    c.attack_mappings = []; c.containment = null; c.decisions = []; c.graph = { nodes: [], edges: [] };
    const m = buildReportModel({ detail: c, report: { ...bruteForceReport, case_id: "case_amb", claims: [] }, source: "live", generatedAt: NOW });
    const dump = JSON.stringify(m.sections);
    expect(dump).toContain("No technique mappings were reported");
    expect(dump).toContain("No containment action is recommended");
    expect(dump).toContain("No analyst decision has been recorded");
    expect(dump).toContain("reported no inferred or missing relationships");
    expect(m.watermark).toBeNull();
  });
  test("mock reports carry the watermark and live reports do not", () => {
    expect(buildReportModel(base).watermark).toBe(MOCK_WATERMARK);
    expect(buildReportModel({ ...base, source: "live" }).watermark).toBeNull();
    expect(JSON.stringify(buildReportModel({ ...base, source: "live" }))).not.toContain(MOCK_WATERMARK);
  });
});

describe("PDF generation", () => {
  test("pdfSafe escapes control and non-Latin-1 characters visibly; breakLong splits unbroken runs", () => {
    expect(pdfSafe("a‮b\u0007c中")).toBe("a\\u202eb\\x07c\\u4e2d");
    expect(pdfSafe("“q” – ok")).toBe('"q" - ok');
    expect(breakLong("x".repeat(25), 10).split(" ")).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("produces a real, selectable, nonempty PDF with the required content", async () => {
    const m = buildReportModel({ detail: bruteForceCase, report: bruteForceReport, source: "live", generatedAt: NOW });
    const { bytes, pages, blob } = await renderReportPdf(m);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(blob.size).toBeGreaterThan(2000);
    expect(blob.type).toBe("application/pdf");
    // table cells wrap on measured width: ordinary words are never split mid-word
    expect(pdfText(bytes)).toContain("authentication_failure");
    expect(pdfText(bytes)).not.toMatch(/authentication_failur(\n| )e/);
    const t = pdfText(bytes);
    for (const s of ["SOC SENTINEL", "Forensic Investigation Report", "case_bf", "2026-11-19T10:15:00.000Z", "Executive summary", "VERDICT", "RISK SCORE (HEURISTIC)", "CONFIDENCE", "COVERAGE", "Supporting findings (3)", "Contradicting findings (1)", "MITRE ATT&CK mappings", "evt_0006", "auth_logs.csv:7", "Appendix A: Source references", "Dry run", "Containment is a dry run", `Page 1 of ${pages}`]) expect(t).toContain(s);
    expect(t).not.toContain(MOCK_WATERMARK);
  });

  test("mock reports are watermarked on every page", async () => {
    const m = buildReportModel({ detail: bruteForceCase, report: bruteForceReport, source: "mock", generatedAt: NOW });
    const { bytes, pages } = await renderReportPdf(m);
    const t = pdfText(bytes);
    // banner on page 1 plus one diagonal watermark per page
    expect(countOf(t, MOCK_WATERMARK)).toBeGreaterThanOrEqual(pages + 1);
    expect(t).toContain("Development fixture (mock)");
  });

  test("long reports paginate cleanly with headers, footers and wrapped unbroken text", async () => {
    const c: CaseDetail = clone(bruteForceCase);
    const long = "A".repeat(500);
    c.events = Array.from({ length: 160 }, (_, i) => ev(i + 1, i % 59, i % 2 ? "authentication_failure" : "authentication_success", i % 2 ? "failure" : "success", { raw_text: `line ${i + 1} ${long}` }));
    c.findings = [{ ...c.findings[0]!, event_ids: c.events.slice(0, 30).map((e) => e.event_id) }];
    const report: ReportResponse = { ...clone(bruteForceReport), claims: [] };
    const m = buildReportModel({ detail: c, report, source: "live", generatedAt: NOW });
    const { bytes, pages } = await renderReportPdf(m);
    expect(pages).toBeGreaterThan(8);
    const t = pdfText(bytes);
    expect(countOf(t, "Forensic investigation report")).toBe(pages); // header on every page
    for (const p of [1, 2, pages]) expect(t).toContain(`Page ${p} of ${pages}`);
    expect(t).toContain("evt_0160");
    // the 500-character token was broken: no single drawn line carries all of it
    expect(t.split("\n").every((l) => l.length < 400)).toBe(true);
    expect(countOf(t, "SOURCE")).toBeGreaterThan(1); // chronology table header repeated across pages
  });

  test("hostile log content is escaped, not drawn raw", async () => {
    const c: CaseDetail = clone(bruteForceCase);
    c.events[0] = { ...c.events[0]!, raw_text: "evil‮\u0000\u001b[31m (paren) \\ back" };
    const { bytes } = await renderReportPdf(buildReportModel({ detail: c, report: bruteForceReport, source: "live", generatedAt: NOW }));
    const t = pdfText(bytes);
    expect(t).toContain("evil\\u202e\\x00\\x1b[31m (paren) \\ back");
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("‮");
  });
});

describe("graph PNG plan", () => {
  const g = buildGraph(bruteForceCase);
  const layout = computeLayout(g, orderEvents(bruteForceCase.events).map((e) => e.event_id));
  const opts = { caseId: "case_bf", source: "mock" as const, exportedAt: NOW, timeOf: timesOf(bruteForceCase.events) };

  test("covers the whole graph, not a viewport: every node and edge is planned inside the canvas", () => {
    const r = planGraphExport(g, layout, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.plan;
    expect(p.nodes).toHaveLength(g.nodes.length);
    expect(p.edges).toHaveLength(g.edges.length);
    for (const n of p.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(p.width);
      expect(n.y - n.h / 2).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h / 2).toBeLessThanOrEqual(p.height);
    }
    expect(p.scale).toBeGreaterThan(1); // high resolution
    expect(p.pixelWidth).toBe(Math.round(p.width * p.scale));
    expect(p.headline).toContain("case_bf");
    expect(p.meta[0]).toContain("2026-11-19T10:15:00.000Z");
    expect(p.meta[0]).toContain("Development fixture");
    expect(p.legend.join(" ")).toMatch(/observed.*inferred.*missing/s);
    expect(p.watermark).toBe(MOCK_WATERMARK);
  });
  test("live exports carry the live label and no watermark", () => {
    const r = planGraphExport(g, layout, { ...opts, source: "live" });
    if (!r.ok) throw new Error("expected a plan");
    expect(r.plan.watermark).toBeNull();
    expect(r.plan.meta[0]).toContain("Live API");
  });
  test("inferred and missing items stay visually distinct in the plan", () => {
    const r = planGraphExport(g, layout, opts);
    if (!r.ok) throw new Error("expected a plan");
    expect(new Set(r.plan.edges.map((e) => e.state))).toEqual(new Set(["observed", "inferred", "missing"]));
    expect(r.plan.nodes.some((n) => n.state === "missing")).toBe(true);
  });
  test("a very large graph is scaled down under the pixel cap, and an impossible one is refused with a reason", () => {
    const wide = { ...layout };
    const ids = Object.keys(wide);
    wide[ids[0]!] = { x: -6000, y: -4000 };
    wide[ids[1]!] = { x: 6000, y: 4000 };
    const r = planGraphExport(g, wide, opts);
    if (!r.ok) throw new Error("expected a plan");
    expect(r.plan.scale).toBeLessThan(1);
    expect(r.plan.pixelWidth * r.plan.pixelHeight).toBeLessThanOrEqual(MAX_PIXELS);
    wide[ids[0]!] = { x: -60000, y: -4000 };
    wide[ids[1]!] = { x: 60000, y: 4000 };
    const bad = planGraphExport(g, wide, opts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/too large/);
  });
  test("an empty graph is refused", () => {
    const r = planGraphExport({ nodes: [], edges: [], warnings: [] }, {}, opts);
    expect(r).toEqual({ ok: false, reason: "There is no evidence graph to export." });
  });
  test("drawing sends labels through fillText only: node labels, case id, legend and watermark appear", () => {
    const r = planGraphExport(g, layout, opts);
    if (!r.ok) throw new Error("expected a plan");
    const texts: string[] = [];
    const noop = () => undefined;
    const ctx = new Proxy({}, {
      get: (_t, k) => (k === "fillText" ? (s: string) => texts.push(s) : k === "measureText" ? () => ({ width: 10 }) : noop),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    drawPlan(ctx, r.plan as GraphPlan);
    const all = texts.join("\n");
    for (const s of ["alice", "203.0.113.45", "Repeated login failures", "evt_0006", "LEGEND", "case_bf", MOCK_WATERMARK, "VPN gateway logs"]) expect(all).toContain(s);
  });
});

describe("watermark geometry", () => {
  test("the rotated mock watermark fits inside an A4 page with margin (it was once clipped at both ends)", async () => {
    const { jsPDF } = await import("jspdf");
    const { WATERMARK } = await import("./pdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(WATERMARK.size);
    const w = doc.getTextWidth(MOCK_WATERMARK);
    const rad = (WATERMARK.angle * Math.PI) / 180;
    expect(w * Math.cos(rad)).toBeLessThan(595.28 - 60);
    expect(w * Math.sin(rad)).toBeLessThan(841.89 - 60);
  });
});
