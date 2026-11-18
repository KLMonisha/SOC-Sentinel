import {
  adversarialExample,
  bruteForceReport,
  cases,
  meta,
  vpnCounterfactual,
} from "./fixtures";
import type {
  CaseListResponse,
  DecisionRequest,
  DecisionResponse,
  InvestigateRequest,
  InvestigateResponse,
  UploadResponse,
} from "../types";

interface MockResult {
  status: number;
  data: unknown;
}

const notFound = (path: string): MockResult => ({
  status: 404,
  data: { ...meta("err"), error: { code: "not_found", message: `No mock for ${path}` } },
});

/** In-memory decision log so approve/reject is visible within a session. */
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
      cases: Object.values(cases).map((c) => c.summary),
    };
    return { status: 200, data };
  }
  if (method === "GET" && path === "/api/cases") {
    const data: CaseListResponse = { ...meta("list"), cases: Object.values(cases).map((c) => c.summary) };
    return { status: 200, data };
  }

  const m = /^\/api\/cases\/([^/]+)(?:\/(report|counterfactual|investigate|decision))?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const sub = m[2];
    const c = cases[id];
    if (!c) return { status: 404, data: { ...meta("err"), error: { code: "case_not_found", message: `Case ${id} not found` } } };

    if (method === "GET" && !sub) {
      return { status: 200, data: { ...c, decisions: decisions[id] ?? [] } };
    }
    if (method === "GET" && sub === "report") return { status: 200, data: { ...bruteForceReport, case_id: id } };
    if (method === "POST" && sub === "counterfactual") return { status: 200, data: { ...vpnCounterfactual, case_id: id } };
    if (method === "POST" && sub === "investigate") {
      const req = body as InvestigateRequest;
      const data: InvestigateResponse = {
        ...meta("inv"),
        case_id: id,
        tool: req.tool,
        reason: "DEV FIXTURE: no events retrieved.",
        retrieved_events: [],
        budget_remaining: Math.max(0, c.planner.budget_remaining - 1),
        updated_case: c,
        previous: { verdict: c.summary.verdict, risk_score: c.summary.risk_score, confidence: c.confidence },
      };
      return { status: 200, data };
    }
    if (method === "POST" && sub === "decision") {
      const req = body as DecisionRequest;
      const record = {
        decision_id: `dec_${(decisions[id]?.length ?? 0) + 1}`,
        case_id: id,
        decision: req.decision,
        analyst_id: req.analyst_id,
        note: req.note ?? null,
        decided_at: new Date().toISOString(),
        dry_run: true as const,
      };
      (decisions[id] ??= []).push(record);
      const data: DecisionResponse = { ...meta("dec"), record, case_status: req.decision === "approve" ? "approved" : "rejected" };
      return { status: 200, data };
    }
  }
  if (method === "POST" && path === "/api/adversarial/run") return { status: 200, data: adversarialExample };
  return notFound(path);
}
