/**
 * DEVELOPMENT FIXTURES ONLY (reachable only when VITE_USE_MOCKS=true).
 *
 * Eight extra cases so the Command Center can be judged at realistic density. They are generated from a
 * small spec so each case is internally consistent: event counts, first/last seen, entities, finding
 * citations, risk (sum of finding weights), band and verdict all agree. The thresholds below are the
 * mock's own and are NOT the backend's rules. None of this is a detection result or a performance metric.
 */
import {
  SCHEMA_VERSION,
  type CaseDetail,
  type DecisionRecord,
  type Finding,
  type ReportResponse,
  type RiskBand,
  type Severity,
  type SourceEvent,
  type Verdict,
} from "../types";

type Kind = "fail" | "succ" | "web";
type Cite = "fail" | "succ" | "web" | "first" | "tail";

interface FindingSpec {
  rule: string;
  title: string;
  description: string;
  severity: Severity;
  stance: "supporting" | "contradicting";
  weight: number;
  cite: Cite;
}

interface Spec {
  no: number;
  title: string;
  dataset: string;
  start: string;
  windowMin: number;
  fail: number;
  succ: number;
  web: number;
  users: (string | null)[];
  ip: string;
  host: string;
  webHost?: string;
  paths?: string[];
  findings: FindingSpec[];
  missing: { telemetry: string; why: string }[];
  coverage: { ratio: number; present: string[]; missing: string[] };
  confidence: "low" | "medium" | "high";
  confidenceWhy: string;
  rationale: string;
  status?: "approved" | "rejected";
  decision?: { analyst: string; note: string; at: string };
  containment?: { action: string; target: string; rationale: string };
}

const band = (v: number): RiskBand => (v >= 70 ? "high" : v >= 25 ? "investigate" : "low");
const verdictFor = (v: number): Verdict =>
  v >= 70 ? "likely_malicious" : v >= 40 ? "needs_investigation" : v >= 25 ? "insufficient_evidence" : "likely_benign";

/** Deterministic, content-derived stand-in for a SHA-256 (fixtures only). */
function fakeHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  return hex.repeat(4);
}

function buildEvents(s: Spec): SourceEvent[] {
  const kinds: Kind[] = [...Array<Kind>(s.fail).fill("fail"), ...Array<Kind>(s.succ).fill("succ"), ...Array<Kind>(s.web).fill("web")];
  const t0 = Date.parse(s.start);
  const span = s.windowMin * 60_000;
  const counters = { auth: 1, web: 1 };
  return kinds.map((k, i) => {
    const ts = new Date(t0 + Math.round((i * span) / Math.max(kinds.length - 1, 1))).toISOString().replace(".000Z", "Z");
    const user = k === "succ" ? s.users[0] ?? null : s.users[i % s.users.length] ?? null;
    const isWeb = k === "web";
    const host = isWeb ? (s.webHost ?? "web-01") : s.host;
    const path = isWeb ? (s.paths?.[counters.web % (s.paths?.length || 1)] ?? "/") : null;
    const line = isWeb ? ++counters.web : ++counters.auth;
    const raw = isWeb
      ? `${ts},${user ?? "-"},${s.ip},GET ${path} 200,${host}`
      : `${ts},${user ?? "-"},${s.ip},${k === "fail" ? "failed_login" : "success_login"},${host}`;
    return {
      event_id: `evt_${s.no}${String(i + 1).padStart(3, "0")}`,
      timestamp: ts,
      event_type: isWeb ? "web_access" : k === "fail" ? "authentication_failure" : "authentication_success",
      username: user,
      source_ip: s.ip,
      host,
      resource: path,
      outcome: k === "fail" ? "failure" : "success",
      source_file: isWeb ? "web_logs.json" : "auth_logs.csv",
      line_number: line,
      raw_text: raw,
      raw_hash: fakeHash(raw),
    } satisfies SourceEvent;
  });
}

function cite(events: SourceEvent[], c: Cite): string[] {
  const by = (k: string) => events.filter((e) => (k === "fail" ? e.event_type === "authentication_failure" : k === "succ" ? e.event_type === "authentication_success" : e.event_type === "web_access"));
  if (c === "first") return events.slice(0, 1).map((e) => e.event_id);
  if (c === "tail") {
    const f = by("fail");
    const s = by("succ");
    return [...f.slice(-1), ...s.slice(0, 1)].map((e) => e.event_id);
  }
  return by(c).map((e) => e.event_id);
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
/** Case severity = the most severe SUPPORTING finding (matches how the original fixtures read). */
const topSeverity = (fs: Finding[]): Severity =>
  fs.filter((f) => f.stance === "supporting").reduce<Severity>((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), "low");

function build(s: Spec): { detail: CaseDetail; report: ReportResponse } {
  const events = buildEvents(s);
  const findings: Finding[] = s.findings.map((f, i) => ({
    finding_id: `f_${s.no}_${i + 1}`,
    rule_id: f.rule,
    title: f.title,
    description: f.description,
    severity: f.severity,
    stance: f.stance,
    weight: f.stance === "contradicting" ? -Math.abs(f.weight) : Math.abs(f.weight),
    event_ids: cite(events, f.cite),
  }));
  const value = Math.max(0, Math.min(100, findings.reduce((a, f) => a + f.weight, 0)));
  const verdict = verdictFor(value);
  const reasoning = findings.map((f) => `${f.weight > 0 ? "+" : ""}${f.weight} ${f.title.toLowerCase()}`);
  const user = s.users.find((u): u is string => u !== null);
  const entities = [...(user ? [user] : []), s.ip, s.host];
  const decisions: DecisionRecord[] = s.decision
    ? [{
        decision_id: `dec_${s.no}`, case_id: `case_dev_${s.no}`, decision: s.status === "approved" ? "approve" : "reject",
        analyst_id: s.decision.analyst, note: s.decision.note, decided_at: s.decision.at, dry_run: true,
      }]
    : [];

  const detail: CaseDetail = {
    schema_version: SCHEMA_VERSION,
    request_id: `mock-case_dev_${s.no}`,
    summary: {
      case_id: `case_dev_${s.no}`,
      dataset_id: s.dataset,
      title: s.title,
      status: s.status ?? "open",
      verdict,
      risk_score: { value, band: band(value), reasoning },
      severity: topSeverity(findings),
      primary_entities: entities,
      event_count: events.length,
      first_seen: events[0]!.timestamp,
      last_seen: events[events.length - 1]!.timestamp,
    },
    verdict_rationale: `DEV FIXTURE · ${s.rationale}`,
    confidence: { level: s.confidence, rationale: s.confidenceWhy },
    coverage: s.coverage,
    findings,
    missing_evidence: s.missing.map((m, i) => ({ missing_id: `m_${s.no}_${i + 1}`, telemetry: m.telemetry, why_it_matters: m.why })),
    attack_mappings: [],
    graph: { nodes: [], edges: [] },
    events,
    timeline: events.map((e) => ({ event_id: e.event_id, timestamp: e.timestamp, label: e.event_type })),
    planner: { budget_total: 3, budget_remaining: 3, candidates: [] },
    containment: s.containment ? { ...s.containment, dry_run: true } : null,
    decisions,
  };

  const report: ReportResponse = {
    schema_version: SCHEMA_VERSION,
    request_id: `mock-rep_dev_${s.no}`,
    case_id: detail.summary.case_id,
    generated_by: "template_fallback",
    summary: `DEV FIXTURE · ${s.title}.`,
    verdict_rationale: s.rationale,
    claims: findings.map((f, i) => ({ claim_id: `c${i + 1}`, text: f.description, citations: f.event_ids, verified: true, verification_note: null })),
    missing_information: s.missing.map((m) => m.telemetry),
    citation_check: { total: findings.length, verified: findings.length, rejected: 0 },
  };
  return { detail, report };
}

const SPECS: Spec[] = [
  {
    no: 1, title: "Password spray across six accounts", dataset: "ds_dev_fixture_a", start: "2026-11-17T22:10:00Z", windowMin: 38,
    fail: 18, succ: 1, web: 0, users: ["svc-backup", "jmorris", "tlee", "akhan", "rpatel", "dnguyen"], ip: "192.0.2.77", host: "vpn-gw-01",
    findings: [
      { rule: "DET-004", title: "Many accounts failing from one IP", description: "18 failed logins across 6 accounts from 192.0.2.77 within 38 minutes.", severity: "high", stance: "supporting", weight: 30, cite: "fail" },
      { rule: "DET-002", title: "Success after repeated failures", description: "One success for svc-backup followed repeated failures from the same IP.", severity: "medium", stance: "supporting", weight: 15, cite: "tail" },
    ],
    missing: [{ telemetry: "IP reputation", why: "Would show whether 192.0.2.77 is a known scanner." }],
    coverage: { ratio: 0.5, present: ["authentication logs", "VPN gateway logs"], missing: ["IP reputation", "endpoint telemetry"] },
    confidence: "medium", confidenceWhy: "The spray pattern is clear; the outcome of the one success is not.",
    rationale: "One IP touched six accounts, but only one login succeeded and nothing after it is visible.",
  },
  {
    no: 2, title: "Login from a new country, known device", dataset: "ds_dev_fixture_a", start: "2026-11-18T03:05:00Z", windowMin: 12,
    fail: 1, succ: 2, web: 1, users: ["mchen"], ip: "198.51.100.88", host: "server-03", webHost: "web-02", paths: ["/dashboard"],
    findings: [
      { rule: "CTX-002", title: "Source geography changed", description: "mchen authenticated from an address not seen in this dataset before.", severity: "low", stance: "supporting", weight: 15, cite: "succ" },
      { rule: "CTX-006", title: "Known device fingerprint", description: "The successful sessions match the device recorded earlier for mchen.", severity: "low", stance: "contradicting", weight: 10, cite: "succ" },
    ],
    missing: [{ telemetry: "Travel or VPN records", why: "Would explain the new source address." }],
    coverage: { ratio: 0.67, present: ["authentication logs", "web server logs"], missing: ["VPN gateway logs"] },
    confidence: "medium", confidenceWhy: "Two weak signals pull in opposite directions.",
    rationale: "A new source address alone is weak; the matching device lowers concern.",
  },
  {
    no: 3, title: "Bulk export after off-hours login", dataset: "ds_dev_fixture_b", start: "2026-11-18T14:40:00Z", windowMin: 26,
    fail: 2, succ: 1, web: 9, users: ["dwilson"], ip: "203.0.113.9", host: "server-02", webHost: "web-02",
    paths: ["/admin/export", "/admin/users", "/api/v1/reports/all", "/admin/export?page=2", "/admin/export?page=3"],
    findings: [
      { rule: "DET-005", title: "Sensitive endpoint after login", description: "dwilson requested /admin/export minutes after the successful login.", severity: "high", stance: "supporting", weight: 25, cite: "web" },
      { rule: "DET-006", title: "High-volume downloads", description: "9 requests to export and report endpoints within 20 minutes.", severity: "critical", stance: "supporting", weight: 30, cite: "web" },
      { rule: "DET-007", title: "Off-hours login", description: "The successful login fell outside dwilson's usual hours in this dataset.", severity: "medium", stance: "supporting", weight: 20, cite: "succ" },
    ],
    missing: [{ telemetry: "Data-loss prevention logs", why: "Would show what the exports contained." }, { telemetry: "MFA challenge records", why: "Would show whether the login passed a second factor." }],
    coverage: { ratio: 0.5, present: ["authentication logs", "web server logs"], missing: ["DLP logs", "MFA records"] },
    confidence: "medium", confidenceWhy: "Three independent rules agree; export contents are unknown.",
    rationale: "A login followed by sustained export activity on sensitive endpoints, with no benign context available.",
    containment: { action: "Suspend dwilson sessions and review export contents", target: "dwilson / 203.0.113.9", rationale: "Sustained sensitive export after an off-hours login." },
  },
  {
    no: 4, title: "Service account lockout storm", dataset: "ds_dev_fixture_b", start: "2026-11-18T08:00:00Z", windowMin: 55,
    fail: 24, succ: 0, web: 0, users: ["svc-etl"], ip: "10.20.4.31", host: "db-01",
    findings: [
      { rule: "DET-001", title: "Repeated login failures", description: "24 failed logins for svc-etl within 55 minutes.", severity: "high", stance: "supporting", weight: 25, cite: "fail" },
      { rule: "CTX-004", title: "Internal source address", description: "All failures came from an internal address with no success afterwards.", severity: "low", stance: "contradicting", weight: 10, cite: "first" },
    ],
    missing: [{ telemetry: "Service credential rotation log", why: "A recent rotation would explain stale credentials." }],
    coverage: { ratio: 0.33, present: ["authentication logs"], missing: ["rotation log", "host telemetry"] },
    confidence: "low", confidenceWhy: "Pattern is consistent with a misconfigured job as much as an attack.",
    rationale: "Many failures from an internal address with no success; a stale credential is plausible.",
  },
  {
    no: 5, title: "Admin path enumeration from one address", dataset: "ds_dev_fixture_c", start: "2026-11-18T19:25:00Z", windowMin: 18,
    fail: 0, succ: 0, web: 14, users: [null], ip: "192.0.2.140", host: "web-01", webHost: "web-01",
    paths: ["/admin", "/admin/login", "/wp-admin", "/phpmyadmin", "/.env", "/backup.zip", "/admin/config"],
    findings: [
      { rule: "DET-008", title: "Sequential path probing", description: "14 requests to distinct administrative paths in 18 minutes.", severity: "medium", stance: "supporting", weight: 30, cite: "web" },
      { rule: "DET-009", title: "Admin path enumeration", description: "Requests targeted well-known administration and backup paths.", severity: "high", stance: "supporting", weight: 25, cite: "web" },
    ],
    missing: [{ telemetry: "WAF decisions", why: "Would show whether any probe was blocked." }],
    coverage: { ratio: 0.33, present: ["web server logs"], missing: ["WAF logs", "authentication logs"] },
    confidence: "medium", confidenceWhy: "The scanning pattern is clear; no authenticated activity is present.",
    rationale: "Probing of administrative paths with no authentication visible: reconnaissance rather than access.",
  },
  {
    no: 6, title: "Single success after two failures", dataset: "ds_dev_fixture_c", start: "2026-11-18T21:50:00Z", windowMin: 4,
    fail: 2, succ: 1, web: 0, users: ["erivera"], ip: "198.51.100.61", host: "server-02",
    findings: [{ rule: "DET-002", title: "Success after failures", description: "Two failures for erivera were followed by a success from the same IP.", severity: "medium", stance: "supporting", weight: 25, cite: "tail" }],
    missing: [{ telemetry: "Post-login activity", why: "Distinguishes a forgotten password from takeover." }],
    coverage: { ratio: 0.33, present: ["authentication logs"], missing: ["post-login activity", "IP context"] },
    confidence: "low", confidenceWhy: "Three events are not enough to separate benign from malicious.",
    rationale: "A short failure-then-success pair fits both a mistyped password and a takeover.",
  },
  {
    no: 7, title: "Credential stuffing burst from a test range", dataset: "ds_dev_fixture_c", start: "2026-11-19T01:15:00Z", windowMin: 9,
    fail: 11, succ: 1, web: 2, users: ["qa-user1", "qa-user2", "qa-user3"], ip: "198.51.100.200", host: "server-04", webHost: "web-03", paths: ["/login", "/account"],
    status: "rejected", decision: { analyst: "a.moreno", note: "Source is the documented QA range; traffic matches the scheduled load test.", at: "2026-11-19T02:05:00Z" },
    findings: [
      { rule: "DET-001", title: "Repeated login failures", description: "11 failed logins across three accounts within 9 minutes.", severity: "high", stance: "supporting", weight: 25, cite: "fail" },
      { rule: "DET-002", title: "Success after repeated failures", description: "One success followed repeated failures from the same address.", severity: "medium", stance: "supporting", weight: 25, cite: "tail" },
      { rule: "CTX-005", title: "Address inside a documented test range", description: "198.51.100.200 belongs to the QA address range recorded for this dataset.", severity: "low", stance: "contradicting", weight: 30, cite: "first" },
    ],
    missing: [{ telemetry: "Load-test schedule", why: "Confirms the burst was planned." }],
    coverage: { ratio: 0.67, present: ["authentication logs", "web server logs"], missing: ["change calendar"] },
    confidence: "medium", confidenceWhy: "The test-range context is strong but is a dataset annotation, not telemetry.",
    rationale: "The pattern looks hostile in isolation, but the source address is a documented test range.",
  },
  {
    no: 8, title: "Privileged account success after failures", dataset: "ds_dev_fixture_c", start: "2026-11-19T03:20:00Z", windowMin: 22,
    fail: 6, succ: 1, web: 3, users: ["root-admin"], ip: "203.0.113.200", host: "bastion-01", webHost: "web-01", paths: ["/admin/keys", "/admin/export", "/admin/audit"],
    status: "approved", decision: { analyst: "priyanka", note: "Contain pending review. Dry-run only.", at: "2026-11-19T04:10:00Z" },
    findings: [
      { rule: "DET-001", title: "Repeated login failures", description: "6 failed logins for root-admin from 203.0.113.200 within 10 minutes.", severity: "high", stance: "supporting", weight: 25, cite: "fail" },
      { rule: "DET-002", title: "Success after repeated failures", description: "A success followed the failures from the same IP.", severity: "critical", stance: "supporting", weight: 25, cite: "tail" },
      { rule: "DET-005", title: "Sensitive endpoint after login", description: "Access to key and export administration endpoints after the success.", severity: "high", stance: "supporting", weight: 25, cite: "web" },
    ],
    missing: [{ telemetry: "MFA challenge records", why: "Would show whether the privileged login passed a second factor." }],
    coverage: { ratio: 0.5, present: ["authentication logs", "web server logs"], missing: ["MFA records", "endpoint telemetry"] },
    confidence: "medium", confidenceWhy: "Three independent rules agree on a privileged account.",
    rationale: "Repeated failures, a success and administrative access from one address on a privileged account.",
    containment: { action: "Disable root-admin sessions and rotate keys", target: "root-admin / 203.0.113.200", rationale: "Privileged success after failures with administrative access." },
  },
];

const built = SPECS.map(build);

/** Keyed by case_id. Merged into the mock session only when mocks are enabled. */
export const devCases: Record<string, CaseDetail> = Object.fromEntries(built.map((b) => [b.detail.summary.case_id, b.detail]));
export const devReports: Record<string, ReportResponse> = Object.fromEntries(built.map((b) => [b.report.case_id, b.report]));
