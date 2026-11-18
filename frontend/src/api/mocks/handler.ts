/**
 * DEVELOPMENT MOCK of the proposed backend. Mirrors confirmed behaviours
 * (exclude_event only, idempotent investigate, budget errors, trial limits)
 * so the UI can be built against realistic failure modes. It is NOT a security
 * engine: counterfactual output here is a simplified stand-in for the backend rerun.
 */
import { devCases, devReports } from "./devCases";
import { adversarialExample, ambHiddenEvents, cases as seed, meta, reports as seedReports } from "./fixtures";
import {
  ERROR_CODES,
  MAX_ADVERSARIAL_TRIALS,
  type AdversarialRequest,
  type CaseDetail,
  type CaseOutcome,
  type CounterfactualRequest,
  type CounterfactualResponse,
  type DecisionRequest,
  type DecisionResponse,
  type Finding,
  type InvestigateRequest,
  type InvestigateResponse,
  type RiskBand,
  type UploadResponse,
  type Verdict,
} from "../types";

interface MockResult {
  status: number;
  data: unknown;
}

const err = (status: number, code: string, message: string): MockResult => ({
  status,
  data: { ...meta("err"), error: { code, message } },
});

// Session state: mutated only by investigate/decision. Counterfactuals never touch it.
const state: Record<string, CaseDetail> = structuredClone({ ...seed, ...devCases });
const reports = { ...seedReports, ...devReports };
const idempotent = new Map<string, InvestigateResponse>();

const band = (v: number): RiskBand => (v >= 70 ? "high" : v >= 25 ? "investigate" : "low");
const verdictFor = (b: RiskBand): Verdict =>
  b === "high" ? "likely_malicious" : b === "investigate" ? "needs_investigation" : "likely_benign";

function outcomeOf(c: CaseDetail): CaseOutcome {
  return {
    verdict: c.summary.verdict,
    risk_score: c.summary.risk_score,
    confidence: c.confidence,
    findings: c.findings,
    graph: c.graph,
  };
}

function counterfactual(c: CaseDetail, req: CounterfactualRequest): MockResult {
  const overrides = req?.overrides;
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return err(400, "invalid_request", "At least one override is required.");
  }
  for (const o of overrides as { type?: string }[]) {
    if (o.type !== "exclude_event") {
      return err(400, "UNSUPPORTED_OVERRIDE", `Override type "${String(o.type)}" is not supported. Only exclude_event is available.`);
    }
  }
  const excluded = new Set(overrides.map((o) => o.event_id));
  const known = new Set(c.events.map((e) => e.event_id));
  for (const id of excluded) {
    if (!known.has(id)) return err(404, "EVENT_NOT_FOUND", `Event ${id} does not belong to case ${c.summary.case_id}.`);
  }
  // DEV MOCK stand-in for the backend rerun. A finding with no events left is removed; one that keeps at least
  // two supporting events is kept with a proportionally smaller weight; otherwise it no longer holds.
  const keep: Finding[] = [];
  const removed: CounterfactualResponse["removed"] = [];
  const changed: CounterfactualResponse["changed"] = [];
  for (const f of c.findings) {
    const hit = f.event_ids.filter((id) => excluded.has(id));
    if (!hit.length) { keep.push(f); continue; }
    const remaining = f.event_ids.filter((id) => !excluded.has(id));
    if (remaining.length >= 2) {
      const after: Finding = {
        ...f,
        weight: Math.sign(f.weight) * Math.round((Math.abs(f.weight) * remaining.length) / f.event_ids.length),
        event_ids: remaining,
        description: `${f.description} (DEV MOCK: ${remaining.length} of ${f.event_ids.length} supporting events remain.)`,
      };
      changed.push({ before: f, after, reason: `Supporting event ${hit.join(", ")} was excluded; ${remaining.length} of ${f.event_ids.length} remain.` });
      keep.push(after);
    } else {
      removed.push({ finding: f, reason: `Supporting event ${hit.join(", ")} was excluded, so this finding no longer holds.` });
    }
  }
  const value = Math.max(0, Math.min(100, keep.reduce((n, f) => n + f.weight, 0)));
  const b = band(value);
  const supportingLeft = keep.filter((f) => f.stance === "supporting").length;
  const original = outcomeOf(c);
  const recomputed: CaseOutcome = {
    verdict: keep.length === 0 ? "insufficient_evidence" : verdictFor(b),
    risk_score: { value, band: b, reasoning: [`DEV MOCK: ${keep.length} finding(s) remain after exclusion`] },
    confidence: { level: supportingLeft >= 3 ? "medium" : "low", rationale: `DEV MOCK confidence: ${supportingLeft} supporting finding(s) remain.` },
    findings: keep,
    graph: c.graph,
  };
  const data: CounterfactualResponse = {
    ...meta("cf"),
    case_id: c.summary.case_id,
    original,
    recomputed,
    score_delta: value - original.risk_score.value,
    added: [],
    removed,
    changed,
    explanation: "DEV MOCK: simplified stand-in for the backend's real rerun of detection, correlation and scoring.",
  };
  return { status: 200, data };
}

function investigate(c: CaseDetail, req: InvestigateRequest): MockResult {
  if (!req?.idempotency_key) return err(400, "invalid_request", "idempotency_key is required.");
  const cacheKey = `${c.summary.case_id}:${req.idempotency_key}`;
  const prior = idempotent.get(cacheKey);
  if (prior) return { status: 200, data: prior }; // retry: no extra budget
  if (c.planner.budget_remaining <= 0) {
    return err(409, ERROR_CODES.BUDGET_EXHAUSTED, "The investigation query budget is exhausted.");
  }
  const candidate = c.planner.candidates.find((x) => x.tool === req.tool);
  if (!candidate) return err(400, "invalid_request", `Tool ${req.tool} is not available for this case.`);

  const previous = { verdict: c.summary.verdict, risk_score: c.summary.risk_score, confidence: c.confidence };
  const retrieved =
    c.summary.case_id === "case_amb" && req.tool === "get_post_login_activity"
      ? ambHiddenEvents.filter((e) => !c.events.some((x) => x.event_id === e.event_id))
      : [];
  c.events = [...c.events, ...retrieved];
  c.timeline = c.events.map((e) => ({ event_id: e.event_id, timestamp: e.timestamp, label: e.event_type }));
  c.planner = {
    ...c.planner,
    budget_remaining: c.planner.budget_remaining - 1,
    candidates: c.planner.candidates.map((x) => (x.tool === req.tool ? { ...x, used: true, recommended: false } : x)),
  };
  const data: InvestigateResponse = {
    ...meta("inv"),
    case_id: c.summary.case_id,
    tool: req.tool,
    reason: candidate.reason,
    retrieved_events: retrieved,
    budget_remaining: c.planner.budget_remaining,
    updated_case: structuredClone(c),
    previous,
  };
  idempotent.set(cacheKey, data);
  return { status: 200, data };
}

const decisions: Record<string, DecisionResponse["record"][]> = {};

export async function handleMock(method: string, path: string, body?: unknown, form?: FormData): Promise<MockResult> {
  await new Promise((r) => setTimeout(r, 150));

  if (method === "POST" && path === "/api/upload") {
    const file = form?.get("file");
    const data: UploadResponse = {
      ...meta("up"),
      dataset_id: "ds_mock_1",
      filename: file instanceof File ? file.name : "unknown",
      file_sha256: "0".repeat(64),
      counts: { total_records: 9, valid_events: 9, quarantined_records: 0 },
      validation_errors: [],
      cases: Object.values(state).map((c) => c.summary),
    };
    return { status: 200, data };
  }
  if (method === "GET" && path === "/api/cases") {
    return { status: 200, data: { ...meta("list"), cases: Object.values(state).map((c) => c.summary) } };
  }

  if (method === "POST" && path === "/api/adversarial/run") {
    const req = body as AdversarialRequest;
    if (!Number.isInteger(req?.trials) || req.trials < 1 || req.trials > MAX_ADVERSARIAL_TRIALS) {
      return err(400, "invalid_request", `trials must be 1-${MAX_ADVERSARIAL_TRIALS}.`);
    }
    if (!["user_agent_injection", "url_query_contamination", "fake_analyst_authorization"].includes(req.scenario_id)) {
      return err(400, "invalid_request", "Unknown scenario_id.");
    }
    return { status: 200, data: { ...adversarialExample, scenario: { ...adversarialExample.scenario, scenario_id: req.scenario_id } } };
  }

  const m = /^\/api\/cases\/([^/]+)(?:\/(report|counterfactual|investigate|decision))?$/.exec(path);
  if (!m) return err(404, "not_found", `No mock for ${method} ${path}`);
  const id = decodeURIComponent(m[1]!);
  const sub = m[2];
  const c = state[id];
  if (!c) return err(404, "CASE_NOT_FOUND", `Case ${id} not found`);

  if (method === "GET" && !sub) return { status: 200, data: { ...structuredClone(c), decisions: decisions[id] ?? [] } };
  if (method === "GET" && sub === "report") return { status: 200, data: reports[id] };
  if (method === "POST" && sub === "counterfactual") return counterfactual(c, body as CounterfactualRequest);
  if (method === "POST" && sub === "investigate") return investigate(c, body as InvestigateRequest);
  if (method === "POST" && sub === "decision") {
    const req = body as DecisionRequest;
    if (!req?.analyst_id?.trim()) return err(400, "invalid_request", "analyst_id is required.");
    const record = {
      decision_id: `dec_${(decisions[id]?.length ?? 0) + 1}`,
      case_id: id,
      decision: req.decision,
      analyst_id: req.analyst_id.trim(),
      note: req.note ?? null,
      decided_at: new Date().toISOString(),
      dry_run: true as const,
    };
    (decisions[id] ??= []).push(record);
    c.summary.status = req.decision === "approve" ? "approved" : "rejected";
    const data: DecisionResponse = { ...meta("dec"), record, case_status: c.summary.status };
    return { status: 200, data };
  }
  return err(404, "not_found", `No mock for ${method} ${path}`);
}
