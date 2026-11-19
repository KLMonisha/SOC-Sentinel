import { beforeEach, describe, expect, test, vi } from "vitest";
import { ERROR_CODES, type CaseDetail, type InvestigateResponse } from "../types";
import { handleMock, resetMockSession } from "./handler";

type Any = Record<string, any>;
const inv = (id: string, tool: string, key: string, params?: Record<string, string>) =>
  handleMock("POST", `/api/cases/${id}/investigate`, { tool, idempotency_key: key, ...(params ? { params } : {}) });
const getCase = async (id: string) => (await handleMock("GET", `/api/cases/${id}`)).data as CaseDetail;

beforeEach(() => resetMockSession());

describe("investigation scenarios (development fixtures)", () => {
  test("1. evidence retrieved and the assessment changes", async () => {
    const r = await inv("case_amb", "get_post_login_activity", "k1", { username: "bob" });
    const d = r.data as InvestigateResponse;
    expect(r.status).toBe(200);
    expect(d.retrieved_events.map((e) => e.event_id)).toEqual(["evt_0013", "evt_0014"]);
    expect(d.previous.verdict).toBe("insufficient_evidence");
    expect(d.updated_case.summary.verdict).toBe("likely_benign");
    expect(d.updated_case.summary.risk_score.value).toBe(10);
    expect(d.updated_case.coverage.ratio).toBe(0.67);
    expect(d.updated_case.findings.some((f) => f.finding_id === "f_post_routine")).toBe(true);
    expect(d.budget_remaining).toBe(2);
  });

  test("2. evidence retrieved, verdict unchanged", async () => {
    const d = (await inv("case_amb", "get_related_auth_events", "k1")).data as InvestigateResponse;
    expect(d.retrieved_events).toHaveLength(1);
    expect(d.updated_case.summary.verdict).toBe(d.previous.verdict);
    expect(d.updated_case.summary.risk_score.value).toBe(30);
  });

  test("3. no additional evidence, still costs one query", async () => {
    const before = await getCase("case_amb");
    const d = (await inv("case_amb", "get_ip_context", "k1")).data as InvestigateResponse;
    expect(d.retrieved_events).toEqual([]);
    expect(d.budget_remaining).toBe(2);
    expect(d.updated_case.summary.risk_score.value).toBe(before.summary.risk_score.value);
    expect(d.updated_case.events).toHaveLength(before.events.length);
  });

  test("4. budget exhaustion, by use and when spent elsewhere", async () => {
    await inv("case_amb", "get_post_login_activity", "a");
    await inv("case_amb", "get_related_auth_events", "b");
    await inv("case_amb", "get_ip_context", "c");
    const r = await inv("case_amb", "get_ip_context", "d");
    expect(r.status).toBe(409);
    expect((r.data as Any).error.code).toBe(ERROR_CODES.BUDGET_EXHAUSTED);
    expect((await inv("case_inv_spent", "get_ip_context", "z")).status).toBe(409);
    const stale = await getCase("case_inv_stale");
    expect(stale.planner.budget_remaining).toBe(1); // the page believes one is left...
    expect((await inv("case_inv_stale", "get_post_login_activity", "z")).status).toBe(409); // ...the backend disagrees
  });

  test("5. a failed request is not charged and succeeds on retry with the same key", async () => {
    const first = await inv("case_inv_flaky", "get_ip_context", "kf");
    expect(first.status).toBe(503);
    expect((await getCase("case_inv_flaky")).planner.budget_remaining).toBe(3);
    const retry = await inv("case_inv_flaky", "get_ip_context", "kf");
    expect(retry.status).toBe(200);
    expect((retry.data as InvestigateResponse).budget_remaining).toBe(2);
  });

  test("6. the same idempotency key returns the stored response and charges nothing", async () => {
    const a = (await inv("case_amb", "get_post_login_activity", "same")).data as InvestigateResponse;
    const b = (await inv("case_amb", "get_post_login_activity", "same")).data as InvestigateResponse;
    expect(b).toEqual(a);
    expect((await getCase("case_amb")).planner.budget_remaining).toBe(2);
  });

  test("the same key with a different tool is refused, not charged", async () => {
    await inv("case_amb", "get_post_login_activity", "same");
    const r = await inv("case_amb", "get_ip_context", "same");
    expect(r.status).toBe(409);
    expect((r.data as Any).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await getCase("case_amb")).planner.budget_remaining).toBe(2);
  });

  test("the slow scenario executes once; the retry returns the stored result", async () => {
    vi.useFakeTimers();
    try {
      const slow = inv("case_inv_flaky", "get_related_auth_events", "ks", { username: "carol" });
      await vi.advanceTimersByTimeAsync(20_000);
      const first = (await slow).data as InvestigateResponse;
      expect(first.budget_remaining).toBe(2);
      const again = inv("case_inv_flaky", "get_related_auth_events", "ks", { username: "carol" }); // stored: no 18 s wait
      await vi.advanceTimersByTimeAsync(200);
      const retry = await again;
      expect((retry.data as InvestigateResponse).budget_remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a case with no candidates has nothing to run", async () => {
    expect((await getCase("case_bf")).planner.candidates).toEqual([]);
  });

  test("an idempotency key is required", async () => {
    expect((await handleMock("POST", "/api/cases/case_amb/investigate", { tool: "get_ip_context" })).status).toBe(400);
  });
});
