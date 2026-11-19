import { describe, expect, test } from "vitest";
import { evidencePath, reportPath, resolveCitations } from "./citations";

describe("resolveCitations", () => {
  const known = new Set(["evt_0001", "evt_0002"]);
  test("splits real events from unresolved ones and never drops either", () => {
    expect(resolveCitations(["evt_0001", "evt_9999", "evt_0002"], known)).toEqual({ resolved: ["evt_0001", "evt_0002"], unresolved: ["evt_9999"] });
  });
  test("de-duplicates repeated citations", () => {
    expect(resolveCitations(["evt_0001", "evt_0001"], known).resolved).toEqual(["evt_0001"]);
  });
  test("an empty citation list resolves to nothing, not to everything", () => {
    expect(resolveCitations([], known)).toEqual({ resolved: [], unresolved: [] });
  });
});

describe("paths", () => {
  test("evidence deep links carry the event and are URL-safe", () => {
    expect(evidencePath("case_bf", "evt_0003")).toBe("/app/evidence/case_bf?event=evt_0003");
    expect(evidencePath("case x/1", "evt a&b")).toBe("/app/evidence/case%20x%2F1?event=evt%20a%26b");
    expect(evidencePath("case_bf")).toBe("/app/evidence/case_bf");
  });
  test("report path", () => {
    expect(reportPath("case_bf")).toBe("/app/evidence/case_bf/report");
  });
});
