/**
 * DEVELOPMENT FIXTURES ONLY (reachable only when VITE_USE_MOCKS=true, via the mock handler).
 *
 * Deterministic scripted outcomes for `POST /api/cases/{id}/investigate`. Each script says which
 * *already-existing* events a tool retrieves and how the stored assessment moves afterwards. The moves
 * are hand-written so every screen state can be exercised; they are NOT detection logic and carry no
 * measured performance. Hashes here are placeholder values, not hashes of the text.
 *
 * Scenario map
 *   case_amb          post_login → evidence + assessment changes   related_auth → evidence, verdict unchanged
 *                     ip_context → no additional evidence (still costs budget)
 *   case_inv_flaky    ip_context → first attempt of a key fails (503), retry with the same key succeeds
 *                     related_auth → executes but replies too slowly; the retry with the same key returns the stored result
 *   case_inv_spent    budget already 0
 *   case_inv_stale    planner says 1 left, backend answers INVESTIGATION_BUDGET_EXHAUSTED (spent elsewhere)
 *   case_inv_edge     an unsupported tool, and a retrieval whose events lack provenance fields
 *   case_bf           no candidates
 */
import { ev, meta } from "./fixtures";
import type { CaseDetail, Finding, PlannerCandidate, PlannerTool, RiskBand, SourceEvent, Verdict } from "../types";

export interface Script {
  events: SourceEvent[];
  finding?: Finding;
  verdict?: Verdict;
  confidence?: { level: "low" | "medium" | "high"; rationale: string };
  /** Telemetry that this retrieval makes present (moved out of coverage.missing / missing_evidence). */
  provides?: { telemetry: string; ratio: number };
  /** `fail`: first attempt per idempotency key answers 503 (not charged). `slow`: executes, replies after `delayMs`. */
  behaviour?: "fail_once" | "slow_first";
}

const band = (v: number): RiskBand => (v >= 70 ? "high" : v >= 25 ? "investigate" : "low");

/** Applies a script to a case in place. A script with no events and no finding changes nothing. */
export function applyScript(c: CaseDetail, s: Script): void {
  const have = new Set(c.events.map((e) => e.event_id));
  const fresh = s.events.filter((e) => !have.has(e.event_id));
  c.events = [...c.events, ...fresh];
  c.timeline = c.events.map((e) => ({ event_id: e.event_id, timestamp: e.timestamp, label: e.event_type }));
  if (s.finding && !c.findings.some((f) => f.finding_id === s.finding!.finding_id)) c.findings = [...c.findings, s.finding];
  if (fresh.length || s.finding) {
    const value = Math.max(0, Math.min(100, c.findings.reduce((n, f) => n + f.weight, 0)));
    c.summary.risk_score = { value, band: band(value), reasoning: c.findings.map((f) => `${f.weight > 0 ? "+" : ""}${f.weight} ${f.title}`) };
    if (s.verdict) c.summary.verdict = s.verdict;
    if (s.confidence) c.confidence = s.confidence;
    c.summary.event_count = c.events.length;
    c.summary.last_seen = c.events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), c.summary.last_seen);
  }
  if (s.provides && fresh.length) {
    c.coverage = {
      ratio: s.provides.ratio,
      present: [...c.coverage.present, s.provides.telemetry],
      missing: c.coverage.missing.filter((m) => m !== s.provides!.telemetry),
    };
    c.missing_evidence = c.missing_evidence.filter((m) => m.telemetry !== s.provides!.telemetry);
  }
}

const ORIGINAL_CAND = (tool: PlannerTool, params: Record<string, string>, relevance: number, gain: number, reason: string, recommended = false): PlannerCandidate => ({
  tool, params, relevance, expected_uncertainty_reduction: gain, retrieval_cost: 1, recommended, reason, used: false,
});

interface Spec {
  id: string;
  title: string;
  rationale: string;
  user: string;
  ip: string;
  host: string;
  firstNo: number;
  minute: number;
  budgetRemaining: number;
  candidates: PlannerCandidate[];
  missing: { telemetry: string; why: string }[];
  coverage: { ratio: number; present: string[]; missing: string[] };
}

function build(s: Spec): CaseDetail {
  const events = [
    ev(s.firstNo, s.minute, "authentication_failure", "failure", { username: s.user, source_ip: s.ip, host: s.host, raw_text: `2026-11-18T11:${String(s.minute).padStart(2, "0")}:00Z,${s.user},${s.ip},failed_login,${s.host}`, timestamp: `2026-11-18T11:${String(s.minute).padStart(2, "0")}:00Z` }),
    ev(s.firstNo + 1, s.minute + 2, "authentication_success", "success", { username: s.user, source_ip: s.ip, host: s.host, raw_text: `2026-11-18T11:${String(s.minute + 2).padStart(2, "0")}:00Z,${s.user},${s.ip},success_login,${s.host}`, timestamp: `2026-11-18T11:${String(s.minute + 2).padStart(2, "0")}:00Z` }),
  ];
  const finding: Finding = {
    finding_id: `f_${s.id}`, rule_id: "DET-002", title: "Success after failure",
    description: `One failure then one success for ${s.user}. DEV FIXTURE.`, severity: "medium", stance: "supporting", weight: 25,
    event_ids: events.map((e) => e.event_id),
  };
  return {
    ...meta(s.id),
    summary: {
      case_id: s.id, dataset_id: "ds_mock_1", title: s.title, status: "open", verdict: "insufficient_evidence",
      risk_score: { value: 25, band: "investigate", reasoning: ["+25 Success after failure"] }, severity: "medium",
      primary_entities: [s.user, s.ip], event_count: events.length, first_seen: events[0]!.timestamp, last_seen: events[1]!.timestamp,
    },
    verdict_rationale: s.rationale,
    confidence: { level: "low", rationale: "Only two events are in scope; the missing telemetry below could change this." },
    coverage: s.coverage,
    findings: [finding],
    missing_evidence: s.missing.map((m, i) => ({ missing_id: `m_${s.id}_${i}`, telemetry: m.telemetry, why_it_matters: m.why })),
    attack_mappings: [],
    graph: { nodes: [], edges: [] },
    events,
    timeline: events.map((e) => ({ event_id: e.event_id, timestamp: e.timestamp, label: e.event_type })),
    planner: { budget_total: 3, budget_remaining: s.budgetRemaining, candidates: s.candidates },
    containment: null,
    decisions: [],
  };
}

const flakyIp = "198.51.100.77";
const flaky = build({
  id: "case_inv_flaky", title: "Carol: sign-in after a failure (unreliable retrieval)", user: "carol", ip: flakyIp, host: "server-03", firstNo: 31, minute: 0, budgetRemaining: 3,
  rationale: "Failure-then-success is consistent with a typo or a takeover; related events and address context are not yet retrieved.",
  candidates: [
    ORIGINAL_CAND("get_ip_context", { ip: flakyIp }, 0.8, 0.7, "Other activity from this address would show whether it is a shared or hostile source.", true),
    ORIGINAL_CAND("get_related_auth_events", { username: "carol" }, 0.6, 0.5, "Earlier sign-in attempts would show whether this was a one-off."),
  ],
  missing: [{ telemetry: "IP context", why: "Shows whether this address touched other accounts." }, { telemetry: "Related authentication events", why: "Shows whether this was isolated." }],
  coverage: { ratio: 0.33, present: ["authentication logs"], missing: ["IP context", "Related authentication events"] },
});

const spent = build({
  id: "case_inv_spent", title: "Dave: budget spent", user: "dave", ip: "203.0.113.90", host: "server-04", firstNo: 41, minute: 10, budgetRemaining: 0,
  rationale: "The investigation budget for this case has been used; the remaining candidates cannot be run.",
  candidates: [
    { ...ORIGINAL_CAND("get_post_login_activity", { username: "dave" }, 0.9, 0.8, "Post-login behaviour best separates benign recovery from takeover."), used: true },
    { ...ORIGINAL_CAND("get_related_auth_events", { username: "dave" }, 0.6, 0.5, "Wider failure history."), used: true },
    { ...ORIGINAL_CAND("get_ip_context", { ip: "203.0.113.90" }, 0.5, 0.4, "Address context.") , used: true },
    ORIGINAL_CAND("get_post_login_activity", { username: "dave", host: "server-04" }, 0.3, 0.2, "A narrower repeat of an earlier query."),
  ],
  missing: [{ telemetry: "Endpoint telemetry", why: "Not part of the three available tools." }],
  coverage: { ratio: 0.5, present: ["authentication logs", "web server logs"], missing: ["Endpoint telemetry"] },
});

const stale = build({
  id: "case_inv_stale", title: "Erin: budget spent elsewhere", user: "erin", ip: "203.0.113.120", host: "server-05", firstNo: 51, minute: 20, budgetRemaining: 1,
  rationale: "This page was loaded when one query remained; another session has since used it.",
  candidates: [
    ORIGINAL_CAND("get_post_login_activity", { username: "erin" }, 0.9, 0.8, "Post-login behaviour best separates benign recovery from takeover.", true),
    ORIGINAL_CAND("get_ip_context", { ip: "203.0.113.120" }, 0.5, 0.4, "Address context."),
  ],
  missing: [{ telemetry: "Post-login activity", why: "Distinguishes a forgotten password from takeover." }],
  coverage: { ratio: 0.33, present: ["authentication logs"], missing: ["Post-login activity", "IP context"] },
});

const edge = build({
  id: "case_inv_edge", title: "Frank: unsupported tool and incomplete provenance", user: "frank", ip: "203.0.113.150", host: "server-06", firstNo: 61, minute: 30, budgetRemaining: 3,
  rationale: "Exercises candidates and results that the console must not over-trust.",
  candidates: [
    // An unrecognised tool name: shown, labelled unsupported, never sent.
    { ...ORIGINAL_CAND("get_ip_context", { ip: "203.0.113.150" }, 0.4, 0.3, "Candidate named a tool this console does not know."), tool: "get_dns_history" as PlannerTool },
    ORIGINAL_CAND("get_related_auth_events", { username: "frank" }, 0.7, 0.6, "Wider history.", true),
  ],
  missing: [{ telemetry: "Related authentication events", why: "Shows whether this was isolated." }],
  coverage: { ratio: 0.33, present: ["authentication logs"], missing: ["Related authentication events"] },
});

export const investigationCases: Record<string, CaseDetail> = {
  case_inv_flaky: flaky,
  case_inv_spent: spent,
  case_inv_stale: stale,
  case_inv_edge: edge,
};

const f = (id: string, title: string, description: string, weight: number, ids: string[]): Finding => ({
  finding_id: id, rule_id: weight < 0 ? "CTX-002" : "DET-010", title, description: `${description} DEV FIXTURE.`, severity: "low", stance: weight < 0 ? "contradicting" : "supporting", weight, event_ids: ids,
});

const web = (n: number, minute: number, user: string, ip: string, resource: string): SourceEvent =>
  ev(n, minute, "web_access", "success", { username: user, source_ip: ip, host: "web-01", resource, source_file: "web_logs.json", timestamp: `2026-11-18T10:${String(minute).padStart(2, "0")}:00Z`, raw_text: `2026-11-18T10:${String(minute).padStart(2, "0")}:00Z,${user},${ip},GET ${resource} 200,web-01` });

const ambPostLogin: SourceEvent[] = [web(13, 23, "bob", "198.51.100.20", "/dashboard"), web(14, 24, "bob", "198.51.100.20", "/profile")];

/** Keyed `caseId` → tool. A missing entry means "retrieves nothing". */
export const scripts: Record<string, Partial<Record<PlannerTool, Script>>> = {
  case_amb: {
    get_post_login_activity: {
      events: ambPostLogin,
      finding: f("f_post_routine", "Routine post-login activity", "After signing in, bob viewed /dashboard and /profile only.", -15, ["evt_0013", "evt_0014"]),
      verdict: "likely_benign",
      confidence: { level: "medium", rationale: "Post-login activity is now available and shows no sensitive access. DEV FIXTURE." },
      provides: { telemetry: "post-login activity", ratio: 0.67 },
    },
    get_related_auth_events: {
      events: [ev(10, 15, "authentication_failure", "failure", { username: "bob", source_ip: "198.51.100.20", host: "server-02", timestamp: "2026-11-18T10:15:00Z", raw_text: "2026-11-18T10:15:00Z,bob,198.51.100.20,failed_login,server-02" })],
      finding: f("f_earlier_fail", "Earlier failed login from the same address", "A failed login for bob from 198.51.100.20 at 10:15 precedes the pair.", 5, ["evt_0010"]),
    },
    get_ip_context: { events: [] },
  },
  case_inv_flaky: {
    get_ip_context: {
      events: [ev(33, 5, "authentication_failure", "failure", { username: "dave", source_ip: flakyIp, host: "server-03", timestamp: "2026-11-18T11:05:00Z", raw_text: `2026-11-18T11:05:00Z,dave,${flakyIp},failed_login,server-03` })],
      finding: f("f_ip_other", "Same address failed for another account", "198.51.100.77 also failed a login for dave at 11:05.", 20, ["evt_0033"]),
      verdict: "needs_investigation",
      confidence: { level: "medium", rationale: "The address touched a second account. DEV FIXTURE." },
      provides: { telemetry: "IP context", ratio: 0.67 },
      behaviour: "fail_once",
    },
    get_related_auth_events: {
      events: [ev(30, 59, "authentication_failure", "failure", { username: "carol", source_ip: flakyIp, host: "server-03", timestamp: "2026-11-18T10:59:00Z", raw_text: `2026-11-18T10:59:00Z,carol,${flakyIp},failed_login,server-03` })],
      finding: f("f_carol_earlier", "Earlier failed login for the same account", "carol also failed from this address at 10:59.", 5, ["evt_0030"]),
      behaviour: "slow_first",
    },
  },
  case_inv_edge: {
    get_related_auth_events: {
      events: [ev(60, 25, "authentication_failure", "failure", { username: "frank", source_ip: "203.0.113.150", host: "server-06", timestamp: "2026-11-18T11:25:00Z", raw_text: "", source_file: "", raw_hash: "" })],
    },
  },
};

export const SLOW_MS = 18000;
