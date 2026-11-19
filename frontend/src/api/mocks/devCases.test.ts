import { describe, expect, test } from "vitest";
import { devCases, devReports } from "./devCases";
import { handleMock } from "./handler";

const all = Object.values(devCases);

describe("dev fixture cases are internally consistent", () => {
  test("there are eight, with varied severity, verdict and status", () => {
    expect(all).toHaveLength(8);
    expect(new Set(all.map((c) => c.summary.severity)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((c) => c.summary.verdict)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((c) => c.summary.status))).toEqual(new Set(["open", "approved", "rejected"]));
  });

  test.each(all.map((c) => [c.summary.case_id, c] as const))("%s: counts, window, citations and risk agree", (_id, c) => {
    const ids = new Set(c.events.map((e) => e.event_id));
    expect(ids.size).toBe(c.events.length);
    expect(c.summary.event_count).toBe(c.events.length);
    const times = c.events.map((e) => Date.parse(e.timestamp));
    expect(Date.parse(c.summary.first_seen)).toBe(Math.min(...times));
    expect(Date.parse(c.summary.last_seen)).toBe(Math.max(...times));
    for (const f of c.findings) for (const id of f.event_ids) expect(ids.has(id)).toBe(true);
    const sum = Math.max(0, Math.min(100, c.findings.reduce((a, f) => a + f.weight, 0)));
    expect(c.summary.risk_score.value).toBe(sum);
    expect(c.summary.risk_score.band).toBe(sum >= 70 ? "high" : sum >= 25 ? "investigate" : "low");
    for (const f of c.findings) expect(f.stance === "contradicting" ? f.weight < 0 : f.weight > 0).toBe(true);
    const lines = c.events.map((e) => `${e.source_file}:${e.line_number}`);
    expect(new Set(lines).size).toBe(lines.length);
    expect(c.decisions.length === 0 ? c.summary.status === "open" : c.summary.status !== "open").toBe(true);
  });

  test("every report claim cites events that exist in its case", () => {
    for (const r of Object.values(devReports)) {
      const ids = new Set(devCases[r.case_id]!.events.map((e) => e.event_id));
      for (const claim of r.claims) for (const id of claim.citations) expect(ids.has(id)).toBe(true);
    }
  });

  test("the mock API serves them alongside the two original cases", async () => {
    const list = (await handleMock("GET", "/api/cases")).data as { cases: { case_id: string }[] };
    expect(list.cases.map((c) => c.case_id)).toEqual(expect.arrayContaining(["case_bf", "case_amb", "case_dev_3"]));
    // 2 original + 8 dev + 4 investigation scenario cases (investigationScenarios.ts)
    expect(list.cases).toHaveLength(14);
  });
});
