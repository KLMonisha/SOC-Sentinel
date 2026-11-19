import { describe, expect, test } from "vitest";
import { DEFAULT_RED_TEAM_TIMEOUT_MS, config, parseTimeoutMs } from "./config";

describe("configurable red-team timeout", () => {
  test("accepts whole milliseconds within range", () => {
    expect(parseTimeoutMs("30000", 90_000)).toBe(30_000);
    expect(parseTimeoutMs(" 1000 ", 90_000)).toBe(1_000);
    expect(parseTimeoutMs("600000", 90_000)).toBe(600_000);
  });
  test.each([undefined, "", "abc", "-5", "1.5", "999", "600001", "1e4", 5000])("falls back for %j", (raw) => {
    expect(parseTimeoutMs(raw, 90_000)).toBe(90_000);
  });
  test("the default applies when the env var is unset", () => {
    expect(DEFAULT_RED_TEAM_TIMEOUT_MS).toBe(90_000);
    expect(config.redTeamTimeoutMs).toBe(90_000);
  });
});
