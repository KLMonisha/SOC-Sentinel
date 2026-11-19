import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { handleMock, resetMockSession } from "@/api/mocks/handler";
import type { CaseDetail, CaseSummary, InvestigateRequest, InvestigateResponse } from "@/api/types";
import { resetSessions } from "@/features/investigation/model";
import { InvestigationIndex } from "./InvestigationIndex";
import { InvestigationLab } from "./InvestigationLab";

vi.mock("@/lib/config", () => ({ config: { useMocks: true, apiBaseUrl: "" } }));
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getCase: vi.fn(), investigate: vi.fn(), listCases: vi.fn() } };
});
import { api } from "@/api/client";

function Probe() {
  const l = useLocation();
  return <p data-testid="room">{l.pathname}{l.search}</p>;
}
const mount = (id = "case_amb", props: { timeoutMs?: number } = {}) =>
  render(
    <MemoryRouter initialEntries={[`/app/investigation/${id}`]}>
      <Routes>
        <Route path="/app/investigation" element={<InvestigationIndex />} />
        <Route path="/app/investigation/:caseId" element={<InvestigationLab {...props} />} />
        <Route path="/app/evidence/:caseId" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );

const unwrap = <T,>(r: { status: number; data: unknown }): T => {
  if (r.status >= 400) {
    const e = (r.data as { error: { code: string; message: string } }).error;
    throw new ApiError(e.message, e.code, r.status, "req-x");
  }
  return r.data as T;
};
/** Route calls through the contract-shaped dev mock (instant: the mock's own latency is skipped by real timers here). */
const viaMock = () => {
  vi.mocked(api.getCase).mockImplementation(async (id) => unwrap<CaseDetail>(await handleMock("GET", `/api/cases/${id}`)));
  vi.mocked(api.investigate).mockImplementation(async (id, body) => unwrap<InvestigateResponse>(await handleMock("POST", `/api/cases/${id}/investigate`, body)));
};
const modules = () => screen.findAllByTestId("candidate");
const moduleFor = async (tool: string, nth = 0) => (await modules()).filter((m) => m.getAttribute("data-tool") === tool)[nth]!;
const select = async (tool: string, nth = 0) => userEvent.click(within(await moduleFor(tool, nth)).getByRole("button", { name: /^(select|selected)/i }));
const run = async (tool: string) => {
  await select(tool);
  await userEvent.click(screen.getByRole("button", { name: /^execute/i }));
};
const remaining = () => screen.getByTestId("budget-remaining").textContent;

beforeEach(() => {
  vi.resetAllMocks();
  resetMockSession();
  resetSessions();
  viaMock();
});

describe("planner", () => {
  test("renders every backend candidate with tool, reason, parameters, expected value and a Proposed status", async () => {
    mount();
    const mods = await modules();
    expect(mods).toHaveLength(3);
    const first = mods[0]!;
    expect(within(first).getByTestId("candidate-tool")).toHaveTextContent("get_post_login_activity");
    expect(first).toHaveTextContent("Post-login behaviour best separates benign recovery from takeover.");
    expect(within(first).getByTestId("candidate-param")).toHaveTextContent("bob");
    expect(within(first).getByTestId("candidate-gain")).toHaveTextContent("0.80");
    expect(within(first).getByTestId("candidate-status")).toHaveTextContent("Proposed");
    expect(within(first).getByText(/Nothing has been retrieved/)).toBeInTheDocument();
    // a proposal is not evidence
    expect(screen.getByTestId("ledger-empty")).toHaveTextContent("No query has been run yet");
    expect(screen.queryByTestId("ledger")).toBeNull();
    expect(api.investigate).not.toHaveBeenCalled();
  });

  test("shows the case's missing evidence and labels development fixtures in mock mode", async () => {
    mount();
    await modules();
    expect(screen.getByTestId("missing-list")).toHaveTextContent("Post-login activity");
    expect(screen.getByText(/Development fixture · scripted outcomes/)).toBeInTheDocument();
  });

  test("selecting a tool previews the exact request; nothing is sent until Execute", async () => {
    mount();
    await select("get_ip_context");
    const stage = screen.getByTestId("execution-stage");
    expect(stage).toHaveTextContent("POST /investigate · get_ip_context");
    expect(stage).toHaveTextContent("198.51.100.20");
    expect(screen.getByTestId("idempotency-key")).toHaveTextContent("assigned when you execute");
    expect(screen.getByTestId("stage-rail")).toHaveAttribute("data-stage", "proposed");
    expect(api.investigate).not.toHaveBeenCalled();
  });

  test("no candidates is an explicit empty state", async () => {
    mount("case_bf");
    expect(await screen.findByText("No investigation candidates")).toBeInTheDocument();
  });

  test("an unsupported tool is shown, labelled, and cannot be selected or sent", async () => {
    mount("case_inv_edge");
    const unsupported = (await modules())[0]!;
    expect(unsupported).toHaveAttribute("data-status", "unsupported");
    expect(unsupported).toHaveTextContent("will not be sent");
    expect(within(unsupported).getByRole("button", { name: /select/i })).toBeDisabled();
  });
});

describe("execution and budget", () => {
  test("a successful query sends the candidate's own parameters and a UUID key, then updates the budget from the response", async () => {
    mount();
    await modules();
    expect(remaining()).toBe("3");
    await run("get_post_login_activity");
    await waitFor(() => expect(remaining()).toBe("2"));
    expect(api.investigate).toHaveBeenCalledTimes(1);
    const [caseId, body] = vi.mocked(api.investigate).mock.calls[0]!;
    expect(caseId).toBe("case_amb");
    expect(body).toMatchObject({ tool: "get_post_login_activity", params: { username: "bob" } });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByTestId("budget-used")).toHaveTextContent("1");
    expect(screen.getAllByTestId("budget-segment").map((s) => s.getAttribute("data-state"))).toEqual(["used", "available", "available"]);
    expect(await moduleFor("get_post_login_activity")).toHaveAttribute("data-status", "retrieved");
  });

  test("the budget is not decremented optimistically while the query is in flight", async () => {
    let release!: (r: InvestigateResponse) => void;
    vi.mocked(api.investigate).mockImplementation(async (id, body) => {
      const real = unwrap<InvestigateResponse>(await handleMock("POST", `/api/cases/${id}/investigate`, body));
      return new Promise((res) => { release = () => res(real); });
    });
    mount();
    await run("get_post_login_activity");
    await waitFor(() => expect(screen.getByTestId("execution-stage")).toHaveAttribute("data-run", "executing"));
    expect(remaining()).toBe("3");
    expect(screen.getByTestId("budget-used")).toHaveTextContent("0");
    expect(screen.getAllByTestId("budget-segment")[0]).toHaveAttribute("data-state", "executing");
    expect(screen.getByTestId("stage-rail")).toHaveAttribute("data-stage", "executing");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release(undefined as never);
    await waitFor(() => expect(remaining()).toBe("2"));
  });

  test("rapid double-click submits once", async () => {
    mount();
    await select("get_post_login_activity");
    const btn = screen.getByRole("button", { name: /^execute/i });
    await userEvent.dblClick(btn);
    await waitFor(() => expect(remaining()).toBe("2"));
    expect(api.investigate).toHaveBeenCalledTimes(1);
  });

  test("two different actions use two different idempotency keys", async () => {
    mount();
    await run("get_post_login_activity");
    await waitFor(() => expect(remaining()).toBe("2"));
    await run("get_related_auth_events");
    await waitFor(() => expect(remaining()).toBe("1"));
    const keys = vi.mocked(api.investigate).mock.calls.map((c) => (c[1] as InvestigateRequest).idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  test("a failed request can be retried with the SAME key and is charged once", async () => {
    mount("case_inv_flaky");
    await run("get_ip_context");
    const alert = await screen.findByTestId("run-error");
    expect(alert).toHaveAttribute("data-failure", "failed");
    expect(alert).toHaveTextContent("Nothing was charged");
    expect(remaining()).toBe("3");
    await userEvent.click(screen.getByRole("button", { name: /retry with the same key/i }));
    await waitFor(() => expect(remaining()).toBe("2"));
    const [a, b] = vi.mocked(api.investigate).mock.calls.map((c) => (c[1] as InvestigateRequest).idempotency_key);
    expect(a).toBe(b);
    expect(api.investigate).toHaveBeenCalledTimes(2);
  });

  test("a timeout keeps the key; the retry returns the stored result without a second charge", async () => {
    vi.mocked(api.investigate).mockReset();
    let calls = 0;
    vi.mocked(api.investigate).mockImplementation((id, body, signal) => {
      calls += 1;
      if (calls === 1) {
        // the backend executes, but the reply never arrives in time
        void handleMock("POST", `/api/cases/${id}/investigate`, body);
        return new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError"))));
      }
      return handleMock("POST", `/api/cases/${id}/investigate`, body).then(unwrap<InvestigateResponse>);
    });
    mount("case_amb", { timeoutMs: 60 });
    await run("get_ip_context");
    const alert = await screen.findByTestId("run-error", undefined, { timeout: 3000 });
    expect(alert).toHaveAttribute("data-failure", "timeout");
    expect(remaining()).toBe("3");
    await userEvent.click(screen.getByRole("button", { name: /retry with the same key/i }));
    await waitFor(() => expect(remaining()).toBe("2"));
    const keys = vi.mocked(api.investigate).mock.calls.map((c) => (c[1] as InvestigateRequest).idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    expect((await handleMock("GET", "/api/cases/case_amb")).data).toMatchObject({ planner: { budget_remaining: 2 } });
  });

  test("backend unavailable is explained and recoverable", async () => {
    vi.mocked(api.investigate).mockRejectedValue(new ApiError("Could not reach the SOC Sentinel API.", "network_error", null, null));
    mount();
    await run("get_ip_context");
    const alert = await screen.findByTestId("run-error");
    expect(alert).toHaveAttribute("data-failure", "unavailable");
    expect(alert).toHaveTextContent("could not be reached");
    expect(screen.getByRole("button", { name: /retry with the same key/i })).toBeEnabled();
    expect(remaining()).toBe("3");
  });
});

describe("budget exhaustion", () => {
  test("a case that starts exhausted locks every candidate and sends nothing", async () => {
    mount("case_inv_spent");
    await modules();
    expect(remaining()).toBe("0");
    expect(screen.getByTestId("exhausted-note")).toHaveTextContent("No further queries can be submitted");
    const states = (await modules()).map((m) => m.getAttribute("data-status"));
    expect(states).toEqual(["used_earlier", "used_earlier", "used_earlier", "locked"]);
    for (const m of await modules()) expect(within(m).getByRole("button", { name: /select/i })).toBeDisabled();
    expect(api.investigate).not.toHaveBeenCalled();
  });

  test("INVESTIGATION_BUDGET_EXHAUSTED from the backend locks the console, even if the page thought a query remained", async () => {
    mount("case_inv_stale");
    await modules();
    expect(remaining()).toBe("1");
    await run("get_post_login_activity");
    const alert = await screen.findByTestId("run-error");
    expect(alert).toHaveAttribute("data-failure", "budget_exhausted");
    expect(remaining()).toBe("0");
    expect(screen.getByTestId("exhausted-note")).toBeInTheDocument();
    for (const m of await modules()) expect(within(m).getByRole("button", { name: /select/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /resolve the problem first/i })).toBeDisabled();
    expect(api.investigate).toHaveBeenCalledTimes(1);
  });

  test("using all three queries exhausts the budget", async () => {
    mount();
    for (const t of ["get_post_login_activity", "get_related_auth_events", "get_ip_context"]) {
      await run(t);
      await waitFor(() => expect(within(screen.getByTestId("execution-stage")).queryByText("Executing…")).toBeNull());
    }
    await waitFor(() => expect(remaining()).toBe("0"));
    expect(screen.getAllByTestId("budget-segment").every((s) => s.getAttribute("data-state") === "used")).toBe(true);
    expect(screen.getByTestId("exhausted-note")).toBeInTheDocument();
  });
});

describe("retrieved evidence and assessment", () => {
  test("shows provenance for every returned event and links it to the Evidence Room", async () => {
    mount();
    await run("get_post_login_activity");
    const rows = await screen.findAllByTestId("ledger-row");
    expect(rows).toHaveLength(2);
    const row = rows[0]!;
    expect(within(row).getByTestId("ledger-id")).toHaveTextContent("evt_0013");
    expect(within(row).getByTestId("ledger-time")).toHaveTextContent("2026-11-18 10:23:00 UTC");
    expect(within(row).getByTestId("ledger-source")).toHaveTextContent("web_logs.json");
    expect(within(row).getByTestId("ledger-source")).toHaveTextContent("line 14");
    expect(within(row).getByTestId("ledger-hash").textContent).toMatch(/[0-9a-f]{64}/);
    expect(within(row).getByTestId("ledger-raw")).toHaveTextContent("GET /dashboard 200");
    expect(within(row).getByLabelText("Related entities")).toHaveTextContent("bob");
    expect(within(row).getByLabelText("Relevant findings")).toHaveTextContent("Routine post-login activity");
    expect(within(row).getByTestId("ledger-new")).toHaveTextContent("New to this case");
    expect(within(row).queryByTestId("ledger-provenance-warning")).toBeNull();
    await userEvent.click(within(row).getByRole("link", { name: /open in evidence room/i }));
    expect(screen.getByTestId("room")).toHaveTextContent("/app/evidence/case_amb?event=evt_0013");
  });

  test("raw log content is rendered as inert text", async () => {
    const hostile = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
    vi.mocked(api.investigate).mockImplementation(async (id, body) => {
      const r = unwrap<InvestigateResponse>(await handleMock("POST", `/api/cases/${id}/investigate`, body));
      r.retrieved_events[0] = { ...r.retrieved_events[0]!, raw_text: hostile };
      return r;
    });
    mount();
    await run("get_post_login_activity");
    const raw = (await screen.findAllByTestId("ledger-raw"))[0]!;
    expect(raw.textContent).toBe(hostile);
    expect(raw.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  test("a retrieval that changes the assessment shows before, after, deltas, new findings and what is still missing", async () => {
    mount();
    await run("get_post_login_activity");
    const a = await screen.findByTestId("assessment");
    expect(a).toHaveAttribute("data-outcome", "assessment_changed");
    expect(screen.getByTestId("assessment-headline")).toHaveTextContent("Verdict changed: Insufficient evidence → Likely benign");
    expect(screen.getByTestId("before-risk")).toHaveTextContent("25");
    expect(screen.getByTestId("after-risk")).toHaveTextContent("10");
    expect(screen.getByTestId("before-confidence")).toHaveTextContent("low");
    expect(screen.getByTestId("after-confidence")).toHaveTextContent("medium");
    expect(screen.getByTestId("delta-coverage")).toHaveTextContent("33% → 67%");
    expect(screen.getByTestId("finding-changes")).toHaveTextContent("Routine post-login activity");
    expect(screen.getByTestId("remaining-missing")).toHaveTextContent("IP context");
  });

  test("retrieved evidence with an unchanged verdict says so plainly", async () => {
    mount();
    await run("get_related_auth_events");
    const a = await screen.findByTestId("assessment");
    expect(screen.getByTestId("assessment-headline")).toHaveTextContent("Verdict unchanged: Insufficient evidence");
    expect(a).toHaveTextContent("An unchanged verdict is a valid result");
    expect(screen.getByTestId("delta-risk")).toHaveTextContent("+5 (25 → 30)");
    expect(screen.getAllByTestId("ledger-row")).toHaveLength(1);
  });

  test("an empty result is a normal outcome that still used budget", async () => {
    mount();
    await run("get_ip_context");
    expect(await screen.findByTestId("no-matching")).toHaveTextContent("No matching evidence");
    expect(screen.getByTestId("assessment")).toHaveAttribute("data-outcome", "no_evidence");
    expect(screen.getByTestId("assessment-headline")).toHaveTextContent("No additional evidence");
    expect(remaining()).toBe("2");
    expect(screen.queryByTestId("ledger")).toBeNull();
  });

  test("missing provenance is flagged and never filled in", async () => {
    mount("case_inv_edge");
    await run("get_related_auth_events");
    const warn = await screen.findByTestId("ledger-provenance-warning");
    expect(warn).toHaveTextContent("source file");
    expect(warn).toHaveTextContent("raw log content");
    expect(warn).toHaveTextContent("SHA-256 hash");
    expect(screen.getByTestId("ledger-raw")).toHaveTextContent("raw content missing");
    expect(screen.getByTestId("ledger-hash")).toHaveTextContent("missing");
  });

  test("no updated assessment is stated explicitly instead of invented", async () => {
    vi.mocked(api.investigate).mockImplementation(async (id, body) => {
      const r = unwrap<InvestigateResponse>(await handleMock("POST", `/api/cases/${id}/investigate`, body));
      return { ...r, updated_case: undefined as never };
    });
    mount();
    await run("get_post_login_activity");
    const n = await screen.findByTestId("no-assessment");
    expect(n).toHaveTextContent("No updated assessment was returned");
    expect(screen.queryByTestId("assessment")).toBeNull();
    expect(remaining()).toBe("2"); // budget still comes from the response's own field
    // events cannot be linked because the updated case did not come back
    expect((await screen.findAllByTestId("ledger-row"))[0]).toHaveTextContent("Not linkable");
  });
});

describe("case loading and selection", () => {
  test("an invalid case is explained with a way out", async () => {
    vi.mocked(api.getCase).mockRejectedValue(new ApiError("Case nope not found", "CASE_NOT_FOUND", 404, "r1"));
    mount("nope");
    const alert = await screen.findByTestId("load-error");
    expect(alert).toHaveTextContent("Case nope does not exist.");
    expect(within(alert).getByRole("link", { name: /choose another case/i })).toHaveAttribute("href", "/app/investigation");
  });

  test("the index lists cases and links each to its investigation", async () => {
    const summary = (id: string): CaseSummary => ({ ...(structuredClone({}) as object), case_id: id, dataset_id: "d", title: `Case ${id}`, status: "open", verdict: "needs_investigation", risk_score: { value: 30, band: "investigate", reasoning: [] }, severity: "medium", primary_entities: [], event_count: 2, first_seen: "", last_seen: "" });
    vi.mocked(api.listCases).mockResolvedValue({ schema_version: "1.0", request_id: "r", cases: [summary("case_a"), summary("case_b")] });
    render(<MemoryRouter initialEntries={["/app/investigation"]}><Routes><Route path="/app/investigation" element={<InvestigationIndex />} /></Routes></MemoryRouter>);
    const link = await screen.findByRole("link", { name: /Case case_a/ });
    expect(link).toHaveAttribute("href", "/app/investigation/case_a");
  });

  test("results survive leaving and returning to the case in the same session", async () => {
    const first = mount();
    await run("get_post_login_activity");
    await screen.findAllByTestId("ledger-row");
    first.unmount();
    mount();
    expect(await screen.findAllByTestId("ledger-row")).toHaveLength(2);
    expect(remaining()).toBe("2");
    expect(await moduleFor("get_post_login_activity")).toHaveAttribute("data-status", "retrieved");
  });
});
