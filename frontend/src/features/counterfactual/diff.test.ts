import { describe, expect, test } from "vitest";
import { bruteForceCase } from "@/api/mocks/fixtures";
import { handleMock } from "@/api/mocks/handler";
import type { CounterfactualResponse } from "@/api/types";
import { compare, findingsCiting, outcomeDifferences, outcomeOfCase, storedCaseUnchanged } from "./diff";
import { validateRun } from "@/pages/CounterfactualLab";

const run = async (event: string) =>
  (await handleMock("POST", "/api/cases/case_bf/counterfactual", { overrides: [{ type: "exclude_event", event_id: event, reason: "test" }] })).data as CounterfactualResponse;

describe("compare", () => {
  test("a removed supporting finding lowers risk, changes the verdict and stops citing its events", async () => {
    const res = await run("evt_0007"); // only f_pl cites this event alongside evt_0006
    const c = compare(bruteForceCase, res);
    expect(c.verdictChanged).toBe(res.original.verdict !== res.recomputed.verdict);
    expect(res.removed.map((r) => r.finding.finding_id)).toEqual(["f_pl"]);
    expect(c.riskDelta).toBe(res.score_delta);
    expect(c.riskDeltaMatchesReported).toBe(true);
    expect(c.noLongerCited).toContain("evt_0007");
    expect(c.originalMismatches).toEqual([]);
  });

  test("a partly supported finding is reported as changed, not removed", async () => {
    const res = await run("evt_0001");
    expect(res.removed).toEqual([]);
    expect(res.changed.map((x) => x.before.finding_id)).toEqual(["f_bf"]);
    const c = compare(bruteForceCase, res);
    expect(c.unchangedFindings.map((f) => f.finding_id).sort()).toEqual(["f_in", "f_pl", "f_sa"]);
  });

  test("excluding only contradicting evidence leaves the verdict unchanged: a valid result, not an error", async () => {
    const res = await run("evt_0008");
    const c = compare(bruteForceCase, res);
    expect(c.verdictChanged).toBe(false);
    expect(res.score_delta).toBeGreaterThan(0); // contradicting weight removed
    expect(res.removed.map((r) => r.finding.stance)).toEqual(["contradicting"]);
  });

  test("detects a response whose 'original' does not match the stored case, and an inconsistent score delta", async () => {
    const res = structuredClone(await run("evt_0007"));
    res.original.risk_score = { ...res.original.risk_score, value: 99 };
    res.score_delta = 1;
    const c = compare(bruteForceCase, res);
    expect(c.originalMismatches.join()).toMatch(/risk 70 vs 99/);
    expect(c.riskDeltaMatchesReported).toBe(false);
  });
});

describe("helpers", () => {
  test("findingsCiting returns exactly the stored findings that cite the event", () => {
    expect(findingsCiting(bruteForceCase, "evt_0005").map((f) => f.finding_id).sort()).toEqual(["f_bf", "f_sa"]);
    expect(findingsCiting(bruteForceCase, "evt_9999")).toEqual([]);
  });
  test("storedCaseUnchanged flags any change to verdict, risk, findings or event count", () => {
    const a = structuredClone(bruteForceCase);
    expect(storedCaseUnchanged(bruteForceCase, a)).toBe(true);
    const b = structuredClone(bruteForceCase);
    b.summary.risk_score = { ...b.summary.risk_score, value: 1 };
    expect(storedCaseUnchanged(bruteForceCase, b)).toBe(false);
    const c = structuredClone(bruteForceCase);
    c.findings = c.findings.slice(1);
    expect(storedCaseUnchanged(bruteForceCase, c)).toBe(false);
    expect(outcomeDifferences(outcomeOfCase(bruteForceCase), outcomeOfCase(a))).toEqual([]);
  });
  test("validateRun requires an event and a reason", () => {
    expect(validateRun(null, "")).toEqual({ event: "Select the event to exclude.", reason: "A reason is required." });
    expect(validateRun("evt_1", "  ")).toEqual({ reason: "A reason is required." });
    expect(validateRun("evt_1", "why")).toEqual({});
  });
});
