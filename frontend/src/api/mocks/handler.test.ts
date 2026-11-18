import { describe, expect, test } from "vitest";
import { handleMock } from "./handler";
import { ERROR_CODES } from "../types";
import { cases, reports } from "./fixtures";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("mock backend honours confirmed agreements", () => {
  test("reports are case-specific and cite only events in that case", async () => {
    for (const id of Object.keys(cases)) {
      const { data } = await handleMock("GET", `/api/cases/${id}/report`);
      const report = data as Any;
      expect(report.case_id).toBe(id);
      const ids = new Set(cases[id]!.events.map((e) => e.event_id));
      for (const claim of reports[id]!.claims) for (const c of claim.citations) expect(ids.has(c)).toBe(true);
    }
    const a = (await handleMock("GET", "/api/cases/case_bf/report")).data as Any;
    const b = (await handleMock("GET", "/api/cases/case_amb/report")).data as Any;
    expect(a.summary).not.toBe(b.summary);
  });

  test("counterfactual rejects every override except exclude_event", async () => {
    for (const type of ["verified_corporate_vpn", "invalidate_ioc", "verified_maintenance"]) {
      const res = await handleMock("POST", "/api/cases/case_bf/counterfactual", { overrides: [{ type }] });
      expect(res.status).toBe(400);
    }
  });

  test("exclude_event changes findings without mutating the original case", async () => {
    const before = (await handleMock("GET", "/api/cases/case_bf")).data as Any;
    const res = await handleMock("POST", "/api/cases/case_bf/counterfactual", {
      overrides: [{ type: "exclude_event", event_id: "evt_0007", reason: "analyst review" }],
    });
    const cf = res.data as Any;
    expect(res.status).toBe(200);
    expect(cf.removed.length).toBe(1);
    expect(cf.score_delta).toBeLessThan(0);
    const after = (await handleMock("GET", "/api/cases/case_bf")).data as Any;
    expect(after.summary.risk_score.value).toBe(before.summary.risk_score.value);
    expect(after.findings).toHaveLength(before.findings.length);
  });

  test("investigate: idempotent retry spends no budget; budget exhaustion is explicit", async () => {
    const call = (key: string, tool: string) =>
      handleMock("POST", "/api/cases/case_amb/investigate", { tool, idempotency_key: key });
    const first = (await call("k1", "get_post_login_activity")).data as Any;
    expect(first.budget_remaining).toBe(2);
    expect(first.retrieved_events.length).toBeGreaterThan(0);
    const retry = (await call("k1", "get_post_login_activity")).data as Any;
    expect(retry.budget_remaining).toBe(2);
    expect((await call("k2", "get_related_auth_events")).status).toBe(200);
    expect((await call("k3", "get_ip_context")).status).toBe(200);
    const exhausted = await call("k4", "get_ip_context");
    expect(exhausted.status).toBe(409);
    expect((exhausted.data as Any).error.code).toBe(ERROR_CODES.BUDGET_EXHAUSTED);
  });

  test("decision requires analyst_id and is recorded as dry-run", async () => {
    const bad = await handleMock("POST", "/api/cases/case_bf/decision", { decision: "approve", analyst_id: " " });
    expect(bad.status).toBe(400);
    const ok = (await handleMock("POST", "/api/cases/case_bf/decision", { decision: "approve", analyst_id: "priyanka" })).data as Any;
    expect(ok.record.analyst_id).toBe("priyanka");
    expect(ok.record.dry_run).toBe(true);
  });

  test("adversarial enforces trial limit of 10", async () => {
    const mk = (trials: number) => handleMock("POST", "/api/adversarial/run", { scenario_id: "user_agent_injection", trials });
    expect((await mk(10)).status).toBe(200);
    expect((await mk(11)).status).toBe(400);
    expect((await mk(0)).status).toBe(400);
  });
});
