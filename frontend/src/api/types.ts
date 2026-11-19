/**
 * SOC Sentinel API types — PROPOSED contract v1.0 (see /API_CONTRACT.md).
 * Not yet confirmed by Member 1. Every field here is a request to the backend,
 * not a statement of what it currently returns.
 */

export const SCHEMA_VERSION = "1.0";

/** How a piece of information is known. Never collapse these in the UI. */
export type EvidenceState = "observed" | "inferred" | "missing";
export type Severity = "low" | "medium" | "high" | "critical";
export type RiskBand = "low" | "investigate" | "high";
export type Verdict =
  | "likely_malicious"
  | "needs_investigation"
  | "likely_benign"
  | "insufficient_evidence";
export type CaseStatus = "open" | "approved" | "rejected";

/** Confirmed backend error codes the UI handles explicitly. */
export const ERROR_CODES = {
  BUDGET_EXHAUSTED: "INVESTIGATION_BUDGET_EXHAUSTED",
} as const;

/** Confirmed limit: adversarial trials per run. */
export const MAX_ADVERSARIAL_TRIALS = 10;

// ---------- Envelope ----------

export interface Versioned {
  schema_version: string;
  request_id: string;
}

export interface ApiErrorBody extends Versioned {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---------- Scores (three separate outputs; never merged) ----------

export interface RiskScore {
  /** 0–100 heuristic. NOT a probability and not calibrated. */
  value: number;
  band: RiskBand;
  reasoning: string[];
}

export interface Confidence {
  level: "low" | "medium" | "high";
  rationale: string;
}

export interface Coverage {
  /** Fraction (0–1) of expected telemetry sources present. */
  ratio: number;
  present: string[];
  missing: string[];
}

// ---------- Evidence ----------

export interface SourceEvent {
  event_id: string;
  timestamp: string; // ISO-8601 UTC
  event_type: string;
  username: string | null;
  source_ip: string | null;
  host: string | null;
  resource: string | null;
  outcome: "success" | "failure" | "unknown";
  source_file: string;
  line_number: number;
  /** Original, unmodified record text. Untrusted: render as text only. */
  raw_text: string;
  raw_hash: string; // SHA-256
}

export interface Finding {
  finding_id: string;
  rule_id: string;
  title: string;
  description: string;
  severity: Severity;
  stance: "supporting" | "contradicting";
  /** Signed heuristic weight contributed to the risk score. */
  weight: number;
  /** One or more source events. Never empty. */
  event_ids: string[];
}

export interface AttackMapping {
  technique_id: string; // e.g. T1110
  name: string;
  tactic: string;
  /** Observed events that justify the mapping. */
  event_ids: string[];
}

export interface MissingEvidence {
  missing_id: string;
  telemetry: string;
  why_it_matters: string;
}

export interface GraphNode {
  id: string;
  kind: "user" | "ip" | "host" | "event";
  label: string;
  state: EvidenceState;
  /** Present for kind === "event". */
  event_id?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  state: EvidenceState;
  event_ids: string[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------- Planner ----------

export type PlannerTool =
  | "get_related_auth_events"
  | "get_post_login_activity"
  | "get_ip_context";

export interface PlannerCandidate {
  tool: PlannerTool;
  params: Record<string, string>;
  relevance: number;
  expected_uncertainty_reduction: number;
  retrieval_cost: number;
  recommended: boolean;
  /** Why it was (or was not) recommended. */
  reason: string;
  used: boolean;
}

export interface PlannerState {
  budget_total: number;
  budget_remaining: number;
  candidates: PlannerCandidate[];
}

// ---------- Decisions ----------

export interface ContainmentRecommendation {
  action: string;
  target: string;
  rationale: string;
  /** Always true. Approval records a decision; nothing is executed. */
  dry_run: true;
}

export interface DecisionRecord {
  decision_id: string;
  case_id: string;
  decision: "approve" | "reject";
  analyst_id: string;
  note: string | null;
  decided_at: string;
  dry_run: true;
}

// ---------- Case ----------

export interface CaseSummary {
  case_id: string;
  /** A dataset can produce many cases; this preserves the case->dataset link. */
  dataset_id: string;
  title: string;
  status: CaseStatus;
  verdict: Verdict;
  risk_score: RiskScore;
  severity: Severity;
  primary_entities: string[];
  event_count: number;
  first_seen: string;
  last_seen: string;
}

export interface TimelineEntry {
  event_id: string;
  timestamp: string;
  label: string;
}

export interface CaseDetail extends Versioned {
  summary: CaseSummary;
  /** Why the verdict was assigned (distinct from confidence.rationale). */
  verdict_rationale: string;
  confidence: Confidence;
  coverage: Coverage;
  findings: Finding[];
  missing_evidence: MissingEvidence[];
  attack_mappings: AttackMapping[];
  graph: Graph;
  events: SourceEvent[];
  timeline: TimelineEntry[];
  planner: PlannerState;
  containment: ContainmentRecommendation | null;
  decisions: DecisionRecord[];
}

// ---------- POST /api/upload ----------

export interface UploadResponse extends Versioned {
  dataset_id: string;
  filename: string;
  file_sha256: string;
  counts: { total_records: number; valid_events: number; quarantined_records: number };
  validation_errors: { row_number: number; reason: string }[];
  cases: CaseSummary[];
}

// ---------- GET /api/cases ----------

export interface CaseListResponse extends Versioned {
  cases: CaseSummary[];
}

// ---------- GET /api/cases/{id}/report ----------

export interface ReportClaim {
  claim_id: string;
  text: string;
  /** Event IDs that must resolve to stored source events. */
  citations: string[];
  verified: boolean;
  verification_note: string | null;
}

export interface ReportResponse extends Versioned {
  case_id: string;
  generated_by: "llm" | "template_fallback";
  summary: string;
  verdict_rationale: string;
  claims: ReportClaim[];
  missing_information: string[];
  citation_check: { total: number; verified: number; rejected: number };
}

// ---------- POST /api/cases/{id}/counterfactual ----------

/**
 * Confirmed MVP: ONLY exclude_event is supported by the backend.
 * verified_corporate_vpn / invalidate_ioc / verified_maintenance are intentionally
 * not representable until the backend supports them.
 */
export type CounterfactualOverride = { type: "exclude_event"; event_id: string; reason: string };

export interface CounterfactualRequest {
  overrides: CounterfactualOverride[];
}

export interface FindingChange {
  before: Finding;
  after: Finding;
  reason: string;
}

export interface CaseOutcome {
  verdict: Verdict;
  risk_score: RiskScore;
  confidence: Confidence;
  findings: Finding[];
  graph: Graph;
}

export interface CounterfactualResponse extends Versioned {
  case_id: string;
  /** Unchanged stored case. */
  original: CaseOutcome;
  /** Result of genuinely re-running detection, correlation and scoring. */
  recomputed: CaseOutcome;
  score_delta: number;
  added: { finding: Finding; reason: string }[];
  removed: { finding: Finding; reason: string }[];
  changed: FindingChange[];
  explanation: string;
}

// ---------- POST /api/cases/{id}/investigate ----------

export interface InvestigateRequest {
  tool: PlannerTool;
  params?: Record<string, string>;
  /** Repeating the same key must not consume budget twice. */
  idempotency_key: string;
}

export interface InvestigateResponse extends Versioned {
  case_id: string;
  tool: PlannerTool;
  reason: string;
  retrieved_events: SourceEvent[];
  budget_remaining: number;
  updated_case: CaseDetail;
  previous: { verdict: Verdict; risk_score: RiskScore; confidence: Confidence };
}

// ---------- POST /api/adversarial/run ----------

export type AdversarialScenarioId =
  | "user_agent_injection"
  | "url_query_contamination"
  | "fake_analyst_authorization";

export interface AdversarialRequest {
  scenario_id: AdversarialScenarioId;
  trials: number;
}

export interface PipelineResult {
  trials: number;
  injection_successes: number;
  /** One entry per trial; actual outputs. */
  outputs: { trial: number; output: string; injection_succeeded: boolean }[];
  citation_check: { total: number; verified: number; rejected: number };
}

export interface AdversarialResponse extends Versioned {
  scenario: {
    scenario_id: AdversarialScenarioId;
    title: string;
    field: string;
    untrusted_payload: string;
  };
  settings: { model: string; temperature: number };
  baseline: PipelineResult;
  hardened: PipelineResult;
}

// ---------- POST /api/cases/{id}/decision ----------

export interface DecisionRequest {
  decision: "approve" | "reject";
  analyst_id: string;
  note?: string;
}

export interface DecisionResponse extends Versioned {
  record: DecisionRecord;
  case_status: CaseStatus;
}
