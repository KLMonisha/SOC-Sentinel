import { describe, expect, test } from "vitest";
import { ApiError } from "@/api/client";
import { ambiguousCase, ev } from "@/api/mocks/fixtures";
import type { CaseDetail, InvestigateResponse, PlannerCandidate } from "@/api/types";
import {
  budgetOf, buildInvestigateRequest, candidateId, classifyFailure, compareAssessment, IdempotencyKeys, isRetryable, isSupportedTool,
  outcomeOf, provenanceIssues, recordStep, resetSessions, sessionSteps, type Step,
} from "./model";

const cand = (over: Partial<PlannerCandidate> = {}): PlannerCandidate => ({
  tool: "get_post_login_activity", params: { username: "bob" }, relevance: 0.9, expected_uncertainty_reduction: 0.8,
  retrieval_cost: 1, recommended: true, reason: "r", used: false, ...over,
});
const base = (): CaseDetail => structuredClone(ambiguousCase);
const response = (before: CaseDetail, over: Partial<InvestigateResponse> = {}): InvestigateResponse => ({
  schema_version: "1.0", request_id: "r", case_id: before.summary.case_id, tool: "get_ip_context", reason: "x",
  retrieved_events: [], budget_remaining: 3, updated_case: structuredClone(before),
  previous: { verdict: before.summary.verdict, risk_score: before.summary.risk_score, confidence: before.confidence }, ...over,
});

describe("request validation and parameters", () => {
  test("only the three agreed tools are supported", () => {
    expect(["get_related_auth_events", "get_post_login_activity", "get_ip_context"].every(isSupportedTool)).toBe(true);
    expect(isSupportedTool("get_dns_history")).toBe(false);
  });
  test("parameters are forwarded exactly as proposed; none are invented", () => {
    const { request, problems } = buildInvestigateRequest(cand({ params: { username: "bob" } }), "k1");
    expect(problems).toEqual([]);
    expect(request).toEqual({ tool: "get_post_login_activity", params: { username: "bob" }, idempotency_key: "k1" });
  });
  test("a candidate with no parameters sends none", () => {
    expect(buildInvestigateRequest(cand({ params: {} }), "k1").request).toEqual({ tool: "get_post_login_activity", idempotency_key: "k1" });
  });
  test("rejects an unsupported tool, blank key, and blank parameter values before sending", () => {
    expect(buildInvestigateRequest(cand({ tool: "get_dns_history" as never }), "k").request).toBeNull();
    expect(buildInvestigateRequest(cand(), "  ").problems.join()).toMatch(/idempotency key/);
    expect(buildInvestigateRequest(cand({ params: { username: " " } }), "k").problems.join()).toMatch(/username/);
  });
  test("candidate identity ignores parameter order", () => {
    expect(candidateId({ tool: "get_ip_context", params: { a: "1", b: "2" } })).toBe(candidateId({ tool: "get_ip_context", params: { b: "2", a: "1" } }));
  });
});

describe("idempotency keys", () => {
  test("a retry of the same action reuses its key; a new action gets a new key", () => {
    let n = 0;
    const keys = new IdempotencyKeys(() => `key-${++n}`);
    const first = keys.begin("A");
    const retry = keys.begin("A");
    expect(retry.key).toBe(first.key);
    expect(retry.attempt).toBe(2);
    expect(keys.begin("B").key).not.toBe(first.key);
  });
  test("after a definitive outcome the next action gets a fresh key", () => {
    const keys = new IdempotencyKeys();
    const a = keys.begin("A").key;
    keys.release("A");
    expect(keys.begin("A").key).not.toBe(a);
  });
  test("default keys are unique UUIDs", () => {
    const keys = new IdempotencyKeys();
    const ids = new Set(["a", "b", "c"].map((x) => keys.begin(x).key));
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("budget", () => {
  test("is read from the backend, not computed from clicks", () => {
    const c = base();
    expect(budgetOf(c)).toEqual({ total: 3, remaining: 3, used: 0, exhausted: false });
    c.planner.budget_remaining = 1;
    expect(budgetOf(c)).toMatchObject({ used: 2, remaining: 1 });
  });
  test("honours a different authoritative total", () => {
    const c = base();
    c.planner.budget_total = 5;
    c.planner.budget_remaining = 4;
    expect(budgetOf(c)).toMatchObject({ total: 5, used: 1, remaining: 4 });
  });
  test("zero remaining, or backend-confirmed exhaustion, is exhausted", () => {
    const c = base();
    c.planner.budget_remaining = 0;
    expect(budgetOf(c).exhausted).toBe(true);
    c.planner.budget_remaining = 2;
    expect(budgetOf(c, true)).toMatchObject({ exhausted: true, remaining: 0 });
  });
});

describe("failure classification", () => {
  const e = (code: string, status: number | null) => new ApiError("m", code, status, null);
  test("maps named backend codes", () => {
    expect(classifyFailure(e("INVESTIGATION_BUDGET_EXHAUSTED", 409))).toBe("budget_exhausted");
    expect(classifyFailure(e("request_timeout", null))).toBe("timeout");
    expect(classifyFailure(e("network_error", null))).toBe("unavailable");
    expect(classifyFailure(e("CASE_NOT_FOUND", 404))).toBe("invalid_case");
    expect(classifyFailure(e("IDEMPOTENCY_KEY_REUSED", 409))).toBe("key_conflict");
  });
  test("only transient failures are retried with the same key", () => {
    expect(isRetryable(e("request_timeout", null))).toBe(true);
    expect(isRetryable(e("QUERY_FAILED", 503))).toBe(true);
    expect(isRetryable(e("INVESTIGATION_BUDGET_EXHAUSTED", 409))).toBe(false);
    expect(isRetryable(e("invalid_request", 400))).toBe(false);
  });
});

describe("provenance", () => {
  test("a complete event has no issues", () => expect(provenanceIssues(ev(1, 1, "x", "failure", { raw_hash: "a".repeat(64) }))).toEqual([]));
  test("gaps are named, never filled", () => {
    const issues = provenanceIssues({ event_id: "e", timestamp: "bad", source_file: "", line_number: 0, raw_text: "", raw_hash: "xyz" });
    expect(issues).toEqual(["timestamp", "source file", "line number", "raw log content", "SHA-256 hash"]);
  });
});

describe("assessment comparison", () => {
  test("reports backend values, deltas, and new/changed findings", () => {
    const before = base();
    const after = structuredClone(before);
    after.summary.verdict = "likely_benign";
    after.summary.risk_score = { value: 10, band: "low", reasoning: [] };
    after.confidence = { level: "medium", rationale: "x" };
    after.coverage = { ...after.coverage, ratio: 0.67 };
    after.findings = [...after.findings, { ...after.findings[0]!, finding_id: "f_new" }];
    const events = [ev(13, 23, "web_access", "success")];
    const cmp = compareAssessment(before, response(before, { updated_case: after, retrieved_events: events }));
    expect(cmp.verdictChanged).toBe(true);
    expect(cmp.riskDelta).toBe(-15);
    expect(cmp.confidenceChanged).toBe(true);
    expect(cmp.coverageChanged).toBe(true);
    expect(cmp.addedFindings.map((f) => f.finding_id)).toEqual(["f_new"]);
    expect(cmp.newEventIds).toEqual(["evt_0013"]);
    expect(outcomeOf(cmp, events.length)).toBe("assessment_changed");
  });
  test("an unchanged verdict with retrieved evidence is its own outcome", () => {
    const before = base();
    const cmp = compareAssessment(before, response(before));
    expect(cmp.verdictChanged).toBe(false);
    expect(outcomeOf(cmp, 1)).toBe("evidence_no_verdict_change");
    expect(outcomeOf(cmp, 0)).toBe("no_evidence");
  });
  test("no updated case means no assessment is manufactured", () => {
    const before = base();
    const cmp = compareAssessment(before, response(before, { updated_case: undefined as never }));
    expect(cmp.after).toBeNull();
    expect(cmp.riskDelta).toBeNull();
    expect(outcomeOf(cmp, 2)).toBe("no_assessment");
  });
  test("flags a 'previous' that disagrees with the case held before", () => {
    const before = base();
    const res = response(before);
    res.previous = { ...res.previous, verdict: "likely_malicious" };
    expect(compareAssessment(before, res).mismatches.join()).toMatch(/verdict/);
  });
});

describe("session record", () => {
  test("keeps steps per case and can be reset", () => {
    const before = base();
    const step: Step = { id: "k", candidateId: "c", tool: "get_ip_context", params: {}, key: "k", attempts: 1, before, response: response(before), at: "t" };
    recordStep("case_amb", step);
    recordStep("case_amb", step); // the same key is one step, not two
    expect(sessionSteps("case_amb")).toHaveLength(1);
    resetSessions();
    expect(sessionSteps("case_amb")).toHaveLength(0);
  });
});
