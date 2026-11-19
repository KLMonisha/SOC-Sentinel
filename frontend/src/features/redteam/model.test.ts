import { describe, expect, test } from "vitest";
import type { AdversarialResponse, PipelineResult } from "@/api/types";
import { adversarialRun } from "@/api/mocks/redTeamScenarios";
import { buildRequest, isScenarioId, outcomeOf, parseTrials, reviewRun, SCENARIOS, SCENARIO_IDS, summarize, trialNumbers } from "./model";

const pipe = (hits: boolean[], over: Partial<PipelineResult> = {}): PipelineResult => ({
  trials: hits.length,
  injection_successes: hits.filter(Boolean).length,
  outputs: hits.map((h, i) => ({ trial: i + 1, output: `o${i + 1}`, injection_succeeded: h })),
  citation_check: { total: 2, verified: 2, rejected: 0 },
  ...over,
});
const res = (baseline: PipelineResult, hardened: PipelineResult): AdversarialResponse => ({
  schema_version: "1.0", request_id: "r", scenario: { scenario_id: "user_agent_injection", title: "t", field: "user_agent", untrusted_payload: "p" },
  settings: { model: "m", temperature: 0 }, baseline, hardened,
});

describe("scenarios", () => {
  test("exactly the three agreed scenarios, each fully described", () => {
    expect(SCENARIO_IDS).toEqual(["user_agent_injection", "url_query_contamination", "fake_analyst_authorization"]);
    for (const id of SCENARIO_IDS) {
      const s = SCENARIOS[id];
      expect([s.surface, s.violation, s.deviation, s.defence].every((t) => t.length > 20)).toBe(true);
    }
    expect(isScenarioId("sql_injection")).toBe(false);
  });
});

describe("trial count validation", () => {
  test.each([["1", 1], ["10", 10], [" 5 ", 5]])("accepts %s", (raw, n) => expect(parseTrials(raw)).toEqual({ value: n }));
  test.each(["", "0", "11", "-1", "2.5", "abc", "1e1", "05x"])("rejects %j", (raw) => expect(parseTrials(raw)).toHaveProperty("error"));
});

describe("request building", () => {
  test("sends exactly scenario_id and trials", () => {
    expect(buildRequest("url_query_contamination", 4).request).toEqual({ scenario_id: "url_query_contamination", trials: 4 });
  });
  test("refuses unsupported scenarios and out-of-range trials", () => {
    expect(buildRequest("made_up", 3).request).toBeNull();
    expect(buildRequest(null, 3).problems).toHaveLength(1);
    expect(buildRequest("user_agent_injection", 11).request).toBeNull();
    expect(buildRequest("user_agent_injection", NaN).request).toBeNull();
  });
});

describe("summaries come from trial records only", () => {
  test("counts and rate are computed from the returned outputs", () => {
    const s = summarize(pipe([true, false, true, false]));
    expect(s).toMatchObject({ returned: 4, successes: 2, failures: 2, rate: 50, violatedTrials: [1, 3] });
  });
  test("a reported count that disagrees with the records is flagged and not used", () => {
    const s = summarize(pipe([true, false], { injection_successes: 0 }));
    expect(s.successes).toBe(1);
    expect(s.successesMismatch).toBe(true);
  });
  test("no records means no rate", () => {
    expect(summarize(pipe([])).rate).toBeNull();
  });
  test("citation status distinguishes verified, rejected, unchecked and inconsistent", () => {
    const st = (c: PipelineResult["citation_check"]) => summarize(pipe([false], { citation_check: c })).citation.status;
    expect(st({ total: 3, verified: 3, rejected: 0 })).toBe("all_verified");
    expect(st({ total: 3, verified: 1, rejected: 2 })).toBe("some_rejected");
    expect(st({ total: 0, verified: 0, rejected: 0 })).toBe("none_checked");
    expect(st({ total: 5, verified: 1, rejected: 1 })).toBe("inconsistent");
  });
});

describe("run review", () => {
  const req = { scenario_id: "user_agent_injection" as const, trials: 3 };
  test("computes the hardened-minus-baseline rate difference", () => {
    const r = reviewRun(req, res(pipe([true, true, false]), pipe([false, false, false])));
    expect(r.rateDelta).toBe(-66.7);
    expect(r.notes).toEqual([]);
    expect(r.empty || r.partial).toBe(false);
  });
  test("an empty result has no delta", () => {
    const r = reviewRun(req, res(pipe([]), pipe([])));
    expect(r.empty).toBe(true);
    expect(r.rateDelta).toBeNull();
  });
  test("partial results are detected and noted", () => {
    const r = reviewRun(req, res(pipe([true], { trials: 3 }), pipe([false, false, false])));
    expect(r.partial).toBe(true);
    expect(r.notes.join(" ")).toMatch(/reports 3 trials but returned 1/);
  });
  test("a response for a different scenario is flagged", () => {
    const wrong = res(pipe([false, false, false]), pipe([false, false, false]));
    wrong.scenario.scenario_id = "fake_analyst_authorization";
    expect(reviewRun(req, wrong).notes.join(" ")).toMatch(/not the requested/);
  });
  test("trial numbers merge both pipelines; outcomes distinguish not-returned", () => {
    const r = res(pipe([true, false, true]), pipe([false]));
    expect(trialNumbers(r)).toEqual([1, 2, 3]);
    expect(outcomeOf(r.hardened.outputs.find((o) => o.trial === 3))).toBe("not_returned");
    expect(outcomeOf(r.baseline.outputs[0])).toBe("injection_succeeded");
  });
});

describe("development fixtures stay self-consistent (they are not measurements)", () => {
  test.each([[1], [2], [3], [4], [5], [10], [6], [8], [9]])("trials=%i: reported success counts match the records", (n) => {
    for (const id of SCENARIO_IDS) {
      const r = adversarialRun({ scenario_id: id, trials: n }).data as AdversarialResponse;
      for (const p of [r.baseline, r.hardened]) {
        expect(p.injection_successes).toBe(p.outputs.filter((o) => o.injection_succeeded).length);
        expect(p.outputs.every((o) => o.output.startsWith("DEV FIXTURE"))).toBe(true);
      }
    }
  });
});
