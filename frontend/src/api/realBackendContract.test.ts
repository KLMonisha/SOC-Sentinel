import { describe, expect, test } from "vitest";
import { ApiError, parseResponse } from "./client";
import { realAnalyzeResponse, realCounterfactualResponse, realErrorResponse } from "./realBackendSamples";

/**
 * Living record of the gap between the agreed contract and the backend as of d74a66c.
 * When Member 1 adopts the agreed envelope these expectations should flip, which is the point.
 */
describe("real backend vs agreed contract (known gaps)", () => {
  const codeOf = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e instanceof ApiError ? e.code : "other"; }
    return "none";
  };

  test("real responses carry no schema_version/request_id, so the client refuses them rather than guessing", () => {
    expect(codeOf(() => parseResponse(200, realAnalyzeResponse))).toBe("schema_mismatch");
    expect(codeOf(() => parseResponse(200, realCounterfactualResponse))).toBe("schema_mismatch");
  });

  test("real errors are FastAPI {detail}, not the agreed envelope: the analyst only sees a generic message", () => {
    expect("error" in realErrorResponse).toBe(false);
    try { parseResponse(400, realErrorResponse); } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("http_error");
      expect((e as ApiError).message).not.toMatch(/evt_nope/); // the backend's useful detail is currently lost
    }
  });

  test("the analyze response returns event IDs only: no source events for provenance", () => {
    const inc = realAnalyzeResponse.incidents[0]!;
    expect(inc.event_ids.length).toBeGreaterThan(0);
    expect("events" in realAnalyzeResponse).toBe(false);
    expect(inc.event_ids.every((id) => /^evt_[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  test("counterfactual recomputes for real, and incident IDs change when evidence is removed (match on correlation_key)", () => {
    const c = realCounterfactualResponse.counterfactual;
    expect(c.original_data_modified).toBe(false);
    expect(c.comparison.incidents_removed).not.toEqual([]);
    expect(c.comparison.incidents_added).not.toEqual([]);
    const ch = c.comparison.per_incident_changes;
    expect(new Set(ch.map((x) => x.correlation_key)).size).toBe(1);
  });
});
