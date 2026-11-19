import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "./client";

const sources = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("mock / live isolation", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("with mocks off, investigate goes to the network with the exact request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1.0", request_id: "r", case_id: "c1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.investigate("c1", { tool: "get_ip_context", params: { ip: "1.2.3.4" }, idempotency_key: "key-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/cases/c1/investigate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ tool: "get_ip_context", params: { ip: "1.2.3.4" }, idempotency_key: "key-1" });
  });

  test("a live failure never falls back to fixture data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    const err = await api.investigate("case_amb", { tool: "get_ip_context", idempotency_key: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network_error");
  });

  test("a live 409 budget error is surfaced by code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1.0", request_id: "r9", error: { code: "INVESTIGATION_BUDGET_EXHAUSTED", message: "spent" } }), { status: 409 })));
    const err = await api.investigate("c1", { tool: "get_ip_context", idempotency_key: "k" }).catch((e) => e);
    expect(err.code).toBe("INVESTIGATION_BUDGET_EXHAUSTED");
    expect(err.requestId).toBe("r9");
  });

  test("with mocks off, the adversarial run goes to the network with exactly scenario_id and trials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1.0", request_id: "r" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.runAdversarial({ scenario_id: "fake_analyst_authorization", trials: 5 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/adversarial/run");
    expect(JSON.parse(init.body)).toStrictEqual({ scenario_id: "fake_analyst_authorization", trials: 5 });
  });

  test("an out-of-range trial count never reaches the network; a live outage never falls back to fixtures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("down"));
    vi.stubGlobal("fetch", fetchMock);
    const bad = await api.runAdversarial({ scenario_id: "user_agent_injection", trials: 11 }).catch((e) => e);
    expect(bad.code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
    const down = await api.runAdversarial({ scenario_id: "user_agent_injection", trials: 3 }).catch((e) => e);
    expect(down.code).toBe("network_error");
  });

  test("production code reaches fixtures only through the client's dynamic mock import", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\.(ts|tsx)$/.test(path) && !path.includes("/api/mocks/"))
      .filter(([, src]) => /from\s+["'][^"']*mocks\//.test(src) || /import\(["'][^"']*mocks\//.test(src))
      .map(([path]) => path)
      .filter((p) => p !== "/src/api/client.ts");
    expect(offenders).toEqual([]);
    expect(sources["/src/api/client.ts"]).toMatch(/if \(config\.useMocks\)[\s\S]*import\("\.\/mocks\/handler"\)/);
  });
});
