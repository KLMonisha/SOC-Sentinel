/**
 * DEVELOPMENT MOCK of the proposed backend. Mirrors confirmed behaviours
 * (exclude_event only, idempotent investigate, budget errors, trial limits)
 * so the UI can be built against realistic failure modes. It is NOT a security
 * engine: counterfactual output here is a simplified stand-in for the backend rerun.
 */
import { devCases, devReports } from "./devCases";
import { cases as seed, meta, reports as seedReports } from "./fixtures";
import { adversarialRun, RED_TEAM_DELAY_MS, resetRedTeamFixtures } from "./redTeamScenarios";
import { applyScript, investigationCases, scripts, SLOW_MS } from "./investigationScenarios";
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
const state: Record<string, CaseDetail> = structuredClone({ ...seed, ...devCases, ...investigationCases });
/** Cases whose budget another session spent after the page loaded (see investigationScenarios). */
const spentElsewhere = new Set<string>(["case_inv_stale"]);
const reports = { ...seedReports, ...devReports };

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

interface Stored { sig: string; data: InvestigateResponse }
const stored = new Map<string, Stored>();
const failedOnce = new Set<string>();
const sigOf = (tool: string, params?: Record<string, string>) => JSON.stringify([tool, Object.entries(params ?? {}).sort()]);

function investigate(c: CaseDetail, req: InvestigateRequest): MockResult & { delayMs?: number } {
  if (!req?.idempotency_key) return err(400, "invalid_request", "idempotency_key is required.");
  const caseId = c.summary.case_id;
  const cacheKey = `${caseId}:${req.idempotency_key}`;
  const sig = sigOf(req.tool, req.params);
  const prior = stored.get(cacheKey);
  if (prior) {
    // Same key + same request: the stored response, no extra budget. A different request is refused.
    if (prior.sig !== sig) return err(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request.");
    return { status: 200, data: prior.data };
  }
  const script = scripts[caseId]?.[req.tool];
  if (script?.behaviour === "fail_once" && !failedOnce.has(cacheKey)) {
    failedOnce.add(cacheKey); // the backend failed before charging anything
    return err(503, "QUERY_FAILED", "The evidence store did not answer. Nothing was charged; retrying is safe.");
  }
  if (spentElsewhere.has(caseId) || c.planner.budget_remaining <= 0) {
    return err(409, ERROR_CODES.BUDGET_EXHAUSTED, "The investigation query budget is exhausted.");
  }
  // `params` is optional in the contract: omitted means "the candidate's own". When given they must match exactly.
  const candidate = c.planner.candidates.find((x) => x.tool === req.tool && (req.params === undefined || sigOf(x.tool, x.params) === sig));
  if (!candidate) return err(400, "invalid_request", `Tool ${req.tool} with these parameters is not available for this case.`);

  const previous = { verdict: c.summary.verdict, risk_score: c.summary.risk_score, confidence: c.confidence };
  const retrieved = (script?.events ?? []).filter((e) => !c.events.some((x) => x.event_id === e.event_id));
  applyScript(c, script ?? { events: [] });
  c.planner = {
    ...c.planner,
    budget_remaining: c.planner.budget_remaining - 1,
    candidates: c.planner.candidates.map((x) => (x === candidate ? { ...x, used: true, recommended: false } : x)),
  };
  const data: InvestigateResponse = {
    ...meta("inv"),
    case_id: caseId,
    tool: req.tool,
    reason: candidate.reason,
    retrieved_events: structuredClone(retrieved),
    budget_remaining: c.planner.budget_remaining,
    updated_case: structuredClone(c),
    previous,
  };
  stored.set(cacheKey, { sig, data });
  return { status: 200, data, ...(script?.behaviour === "slow_first" ? { delayMs: SLOW_MS } : {}) };
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
    await new Promise((r) => setTimeout(r, RED_TEAM_DELAY_MS)); // a real run is not instant; the lab must show a running state
    return adversarialRun(req);
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
  if (method === "POST" && sub === "investigate") {
    const r = investigate(c, body as InvestigateRequest);
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return { status: r.status, data: r.data };
  }
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

/** Test hook: restore the pristine fixture session (cases, idempotency store, decisions). Mock-only. */
export function resetMockSession(): void {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, structuredClone({ ...seed, ...devCases, ...investigationCases }));
  stored.clear();
  failedOnce.clear();
  resetRedTeamFixtures();
  for (const k of Object.keys(decisions)) delete decisions[k];
}
