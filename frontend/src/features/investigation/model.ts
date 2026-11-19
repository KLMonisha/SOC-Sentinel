/**
 * Pure investigation logic (no React): tool validation, request building, idempotency-key retention,
 * budget reading, provenance checks and the before/after assessment comparison.
 * Nothing here invents data: every value shown to the analyst is read from a backend (or mock) response.
 */
import { ApiError } from "@/api/client";
import {
  ERROR_CODES,
  type CaseDetail,
  type Confidence,
  type Finding,
  type InvestigateRequest,
  type InvestigateResponse,
  type PlannerCandidate,
  type PlannerTool,
  type RiskScore,
  type SourceEvent,
  type Verdict,
} from "@/api/types";

/** The three agreed tools. Anything else a candidate names is shown as unsupported and never sent. */
export const SUPPORTED_TOOLS: readonly PlannerTool[] = ["get_related_auth_events", "get_post_login_activity", "get_ip_context"];
export const isSupportedTool = (t: string): t is PlannerTool => (SUPPORTED_TOOLS as readonly string[]).includes(t);

/** UI-owned wording for what each tool asks. The contract carries no question field; this is a label, not evidence. */
export const TOOL_QUESTION: Record<PlannerTool, string> = {
  get_related_auth_events: "Were there other sign-in attempts around this activity?",
  get_post_login_activity: "What did this account do after it signed in?",
  get_ip_context: "What else is known about this address in the loaded data?",
};

/** Same tool + same params = same logical action. Stable regardless of key order. */
export const candidateId = (c: Pick<PlannerCandidate, "tool" | "params">): string =>
  `${c.tool}|${Object.keys(c.params ?? {}).sort().map((k) => `${k}=${c.params[k]}`).join("&")}`;

export interface BuiltRequest {
  request: InvestigateRequest | null;
  problems: string[];
}

/** Validates before anything is sent. Parameters are the backend's own, forwarded verbatim; none are added. */
export function buildInvestigateRequest(c: Pick<PlannerCandidate, "tool" | "params">, idempotencyKey: string): BuiltRequest {
  const problems: string[] = [];
  if (!isSupportedTool(c.tool)) problems.push(`Tool "${String(c.tool)}" is not supported by this console.`);
  if (!idempotencyKey || !idempotencyKey.trim()) problems.push("An idempotency key is required.");
  const params = c.params ?? {};
  for (const [k, v] of Object.entries(params)) {
    if (!k.trim()) problems.push("A parameter has an empty name.");
    if (typeof v !== "string" || !v.trim()) problems.push(`Parameter "${k}" must be a non-empty string.`);
  }
  if (problems.length) return { request: null, problems };
  const request: InvestigateRequest = {
    tool: c.tool,
    idempotency_key: idempotencyKey,
    ...(Object.keys(params).length ? { params: { ...params } } : {}),
  };
  return { request, problems };
}

/**
 * Retains one idempotency key per logical action. Asking again for the same action (a retry) returns the
 * same key so the backend can recognise it; `release` after a definitive outcome means the next
 * user-initiated action gets a fresh key.
 */
export class IdempotencyKeys {
  private keys = new Map<string, string>();
  private attempts = new Map<string, number>();
  constructor(private make: () => string = () => crypto.randomUUID()) {}
  begin(actionId: string): { key: string; attempt: number } {
    let key = this.keys.get(actionId);
    if (!key) {
      key = this.make();
      this.keys.set(actionId, key);
    }
    const attempt = (this.attempts.get(actionId) ?? 0) + 1;
    this.attempts.set(actionId, attempt);
    return { key, attempt };
  }
  peek(actionId: string): string | undefined {
    return this.keys.get(actionId);
  }
  release(actionId: string): void {
    this.keys.delete(actionId);
    this.attempts.delete(actionId);
  }
}

/** Failures after which re-sending the SAME key is the right thing (the backend may or may not have executed). */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "request_timeout" || e.code === "network_error") return true;
  return e.status !== null && e.status >= 500;
}

export type Failure = "budget_exhausted" | "timeout" | "unavailable" | "invalid_case" | "unsupported_tool" | "key_conflict" | "failed";
export function classifyFailure(e: unknown): Failure {
  if (!(e instanceof ApiError)) return "failed";
  if (e.code === ERROR_CODES.BUDGET_EXHAUSTED) return "budget_exhausted";
  if (e.code === "request_timeout") return "timeout";
  if (e.code === "network_error") return "unavailable";
  if (e.code === "CASE_NOT_FOUND" || e.status === 404) return "invalid_case";
  if (e.code === "UNSUPPORTED_TOOL" || e.code === "invalid_request") return "unsupported_tool";
  if (e.code === "IDEMPOTENCY_KEY_REUSED") return "key_conflict";
  return "failed";
}

export interface Budget {
  total: number;
  remaining: number;
  used: number;
  exhausted: boolean;
}
/** Authoritative budget exactly as the backend reports it. Never decremented locally. */
export function budgetOf(c: CaseDetail, confirmedExhausted = false): Budget {
  const total = Math.max(0, c.planner.budget_total);
  const remaining = confirmedExhausted ? 0 : Math.max(0, Math.min(total, c.planner.budget_remaining));
  return { total, remaining, used: total - remaining, exhausted: remaining === 0 };
}

const HEX64 = /^[0-9a-f]{64}$/i;
/** What is missing from an event's provenance. Never filled in; a gap is shown as a gap. */
export function provenanceIssues(e: Partial<SourceEvent>): string[] {
  const out: string[] = [];
  if (!e.event_id) out.push("event ID");
  if (!e.timestamp || Number.isNaN(new Date(e.timestamp).getTime())) out.push("timestamp");
  if (!e.source_file) out.push("source file");
  if (!Number.isInteger(e.line_number) || (e.line_number as number) < 1) out.push("line number");
  if (typeof e.raw_text !== "string" || e.raw_text === "") out.push("raw log content");
  if (typeof e.raw_hash !== "string" || !HEX64.test(e.raw_hash)) out.push("SHA-256 hash");
  return out;
}

export type EntityKind = "user" | "ip" | "host" | "resource";
export function entitiesOf(e: SourceEvent): { kind: EntityKind; value: string }[] {
  const out: { kind: EntityKind; value: string }[] = [];
  if (e.username) out.push({ kind: "user", value: e.username });
  if (e.source_ip) out.push({ kind: "ip", value: e.source_ip });
  if (e.host) out.push({ kind: "host", value: e.host });
  if (e.resource) out.push({ kind: "resource", value: e.resource });
  return out;
}

export interface Assessment {
  verdict: Verdict;
  risk: RiskScore;
  confidence: Confidence;
}
export interface AssessmentComparison {
  /** `null` when the backend returned no updated case. Nothing is manufactured in that case. */
  updated: CaseDetail | null;
  before: Assessment;
  after: Assessment | null;
  verdictChanged: boolean;
  riskDelta: number | null;
  confidenceChanged: boolean;
  coverageBefore: number;
  coverageAfter: number | null;
  coverageChanged: boolean;
  addedFindings: Finding[];
  removedFindings: Finding[];
  changedFindings: { before: Finding; after: Finding }[];
  remaining: { missing: string[]; coverageMissing: string[]; rationale: string } | null;
  newEventIds: string[];
  /** Differences between `previous` in the response and the case the console held before the query. */
  mismatches: string[];
  budgetMismatch: boolean;
}

export function compareAssessment(before: CaseDetail, res: InvestigateResponse): AssessmentComparison {
  const updated: CaseDetail | null = (res.updated_case as CaseDetail | undefined) ?? null;
  const prev = res.previous;
  const mismatches: string[] = [];
  if (prev.verdict !== before.summary.verdict) mismatches.push(`verdict ${prev.verdict} vs ${before.summary.verdict}`);
  if (prev.risk_score.value !== before.summary.risk_score.value) mismatches.push(`risk ${prev.risk_score.value} vs ${before.summary.risk_score.value}`);
  const beforeA: Assessment = { verdict: prev.verdict, risk: prev.risk_score, confidence: prev.confidence };
  const known = new Set(before.events.map((e) => e.event_id));
  const newEventIds = res.retrieved_events.map((e) => e.event_id).filter((id) => !known.has(id));
  const budgetMismatch = !!updated && updated.planner.budget_remaining !== res.budget_remaining;
  if (!updated) {
    return {
      updated, before: beforeA, after: null, verdictChanged: false, riskDelta: null, confidenceChanged: false,
      coverageBefore: before.coverage.ratio, coverageAfter: null, coverageChanged: false,
      addedFindings: [], removedFindings: [], changedFindings: [], remaining: null, newEventIds, mismatches, budgetMismatch,
    };
  }
  const afterA: Assessment = { verdict: updated.summary.verdict, risk: updated.summary.risk_score, confidence: updated.confidence };
  const b = new Map(before.findings.map((f) => [f.finding_id, f]));
  const a = new Map(updated.findings.map((f) => [f.finding_id, f]));
  const coverageAfter = typeof updated.coverage?.ratio === "number" ? updated.coverage.ratio : null;
  return {
    updated, before: beforeA, after: afterA,
    verdictChanged: beforeA.verdict !== afterA.verdict,
    riskDelta: afterA.risk.value - beforeA.risk.value,
    confidenceChanged: beforeA.confidence.level !== afterA.confidence.level,
    coverageBefore: before.coverage.ratio,
    coverageAfter,
    coverageChanged: coverageAfter !== null && coverageAfter !== before.coverage.ratio,
    addedFindings: updated.findings.filter((f) => !b.has(f.finding_id)),
    removedFindings: before.findings.filter((f) => !a.has(f.finding_id)),
    changedFindings: updated.findings
      .filter((f) => b.has(f.finding_id) && JSON.stringify(b.get(f.finding_id)) !== JSON.stringify(f))
      .map((f) => ({ before: b.get(f.finding_id)!, after: f })),
    remaining: { missing: updated.missing_evidence.map((m) => m.telemetry), coverageMissing: updated.coverage.missing, rationale: updated.confidence.rationale },
    newEventIds, mismatches, budgetMismatch,
  };
}

export type Outcome = "assessment_changed" | "evidence_no_verdict_change" | "no_evidence" | "no_assessment";
export function outcomeOf(cmp: AssessmentComparison, retrieved: number): Outcome {
  if (!cmp.after) return "no_assessment";
  if (retrieved === 0) return "no_evidence";
  const moved = cmp.verdictChanged || cmp.riskDelta !== 0 || cmp.confidenceChanged || cmp.addedFindings.length + cmp.removedFindings.length + cmp.changedFindings.length > 0;
  return moved ? "assessment_changed" : "evidence_no_verdict_change";
}

/** Findings of the updated case that cite an event (the only "relevant findings" the UI will show). */
export const findingsCiting = (c: CaseDetail | null, eventId: string): Finding[] => (c?.findings ?? []).filter((f) => f.event_ids.includes(eventId));

/** Session record of what was executed in this browser session. The contract exposes no query history. */
export interface Step {
  id: string;
  candidateId: string;
  tool: PlannerTool;
  params: Record<string, string>;
  key: string;
  attempts: number;
  before: CaseDetail;
  response: InvestigateResponse;
  at: string;
}
const sessions = new Map<string, Step[]>();
export const sessionSteps = (caseId: string): Step[] => sessions.get(caseId) ?? [];
export const recordStep = (caseId: string, s: Step): void => {
  sessions.set(caseId, [...sessionSteps(caseId).filter((x) => x.id !== s.id), s]);
};
export const resetSessions = (): void => sessions.clear();
