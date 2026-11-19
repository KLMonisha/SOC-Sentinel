import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api, parseResponse } from "./client";
import { bruteForceCase } from "./mocks/fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("parseResponse", () => {
  test("rejects non-object bodies", () => {
    expect(() => parseResponse(200, "nope")).toThrowError(ApiError);
  });
  test("maps an error envelope to ApiError with request id", () => {
    try {
      parseResponse(404, { schema_version: "1.0", request_id: "r1", error: { code: "case_not_found", message: "x" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("case_not_found");
      expect((e as ApiError).requestId).toBe("r1");
    }
  });
  test("rejects an incompatible schema major version", () => {
    expect(() => parseResponse(200, { schema_version: "2.0", request_id: "r" })).toThrowError(/schema/i);
  });
});

describe("api client (mocks off)", () => {
  test("network failure surfaces as ApiError and never falls back to mock data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    await expect(api.listCases()).rejects.toMatchObject({ code: "network_error" });
  });
  test("returns typed data from a valid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ schema_version: "1.0", request_id: "r", cases: [] }) }),
    );
    expect((await api.listCases()).cases).toEqual([]);
  });
});

describe("fixtures", () => {
  test("every finding cites events that exist in the case", () => {
    const ids = new Set(bruteForceCase.events.map((e) => e.event_id));
    for (const f of bruteForceCase.findings) {
      expect(f.event_ids.length).toBeGreaterThan(0);
      for (const id of f.event_ids) expect(ids.has(id)).toBe(true);
    }
  });
});
