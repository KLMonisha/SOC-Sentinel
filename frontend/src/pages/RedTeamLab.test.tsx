import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { handleMock, resetMockSession } from "@/api/mocks/handler";
import type { AdversarialResponse } from "@/api/types";
import { RedTeamLab } from "./RedTeamLab";

vi.mock("@/lib/config", () => ({ config: { useMocks: true, apiBaseUrl: "" } }));
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { runAdversarial: vi.fn() } };
});
import { api } from "@/api/client";

const mount = (props: { timeoutMs?: number } = {}) => render(<MemoryRouter><RedTeamLab {...props} /></MemoryRouter>);
const SLOW = { timeout: 5000 };

const unwrap = (r: { status: number; data: unknown }): AdversarialResponse => {
  if (r.status >= 400) {
    const e = (r.data as { error: { code: string; message: string } }).error;
    throw new ApiError(e.message, e.code, r.status, "req-x");
  }
  return r.data as AdversarialResponse;
};
const viaMock = () => vi.mocked(api.runAdversarial).mockImplementation(async (body) => unwrap(await handleMock("POST", "/api/adversarial/run", body)));

const pick = (id: string) => userEvent.click(document.querySelector(`input[value="${id}"]`) as HTMLElement);
const setTrials = async (v: string) => {
  const box = screen.getByLabelText(/^trials/i);
  await userEvent.clear(box);
  if (v) await userEvent.type(box, v);
};
const start = () => userEvent.click(screen.getByRole("button", { name: /start test|run the test again/i }));
const runIt = async (scenario: string, trials: string) => {
  await pick(scenario);
  await setTrials(trials);
  await start();
  await screen.findByTestId("comparison", undefined, SLOW);
};
const cell = (id: string, col: 0 | 1) => screen.getAllByTestId(id)[col]!;

beforeEach(() => {
  vi.resetAllMocks();
  resetMockSession();
  viaMock();
});

describe("scenario selection", () => {
  test("offers exactly the three supported scenarios, each explained", () => {
    mount();
    const mods = screen.getAllByTestId("scenario");
    expect(mods.map((m) => m.getAttribute("data-scenario"))).toEqual(["user_agent_injection", "url_query_contamination", "fake_analyst_authorization"]);
    for (const m of mods) {
      for (const label of [/attacker-controlled surface/i, /attempted trust-boundary violation/i, /intended deviation/i, /expected defensive behaviour/i]) expect(within(m).getByText(label)).toBeInTheDocument();
      expect(within(m).getByText(/Trusted · system instructions/)).toBeInTheDocument();
      expect(within(m).getByText(/Attacker-controlled · log field/)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  test("no payload or result is shown before a test is run", () => {
    mount();
    expect(screen.getByTestId("idle-note")).toBeInTheDocument();
    expect(screen.queryByTestId("insp-payload")).toBeNull();
    expect(screen.queryByTestId("comparison")).toBeNull();
    expect(screen.getAllByText(/No result yet/)).toHaveLength(2);
  });

  test("starting without a scenario explains why and sends nothing", async () => {
    mount();
    await start();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a scenario");
    expect(api.runAdversarial).not.toHaveBeenCalled();
  });

  test("choosing a scenario is reflected in the exact request preview, and works from the keyboard", async () => {
    mount();
    await pick("url_query_contamination");
    expect(screen.getByTestId("request-preview")).toHaveTextContent('"scenario_id": "url_query_contamination"');
    const first = screen.getAllByRole("radio")[0]!;
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
  });
});

describe("configuration and request", () => {
  test.each([["0", /from 1 to 10/], ["11", /from 1 to 10/], ["abc", /whole number/], ["2.5", /whole number/], ["", /Enter a number/]])("trial count %j is rejected", async (value, msg) => {
    mount();
    await pick("user_agent_injection");
    await setTrials(value);
    await start();
    expect(screen.getByRole("alert")).toHaveTextContent(msg);
    expect(screen.getByLabelText(/^trials/i)).toHaveAttribute("aria-invalid", "true");
    expect(api.runAdversarial).not.toHaveBeenCalled();
  });

  test("the stepper stays within 1–10", async () => {
    mount();
    await setTrials("10");
    expect(screen.getByRole("button", { name: /more trials/i })).toBeDisabled();
    await setTrials("1");
    expect(screen.getByRole("button", { name: /fewer trials/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /more trials/i }));
    expect(screen.getByLabelText(/^trials/i)).toHaveValue("2");
  });

  test("sends exactly the contract payload: scenario_id and integer trials", async () => {
    mount();
    await runIt("url_query_contamination", "4");
    expect(api.runAdversarial).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.runAdversarial).mock.calls[0]![0]).toStrictEqual({ scenario_id: "url_query_contamination", trials: 4 });
  });

  test("a double click starts one run; the control is disabled and shows an indeterminate state while running", async () => {
    mount();
    await pick("user_agent_injection");
    await userEvent.dblClick(screen.getByRole("button", { name: /start test/i }));
    expect(await screen.findByTestId("running-note")).toHaveTextContent(/no progress is available and none is shown/i);
    expect(screen.getByRole("button", { name: /test running/i })).toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("chamber")).toHaveAttribute("data-state", "running");
    expect(document.body.textContent).not.toMatch(/\d+\s?%\s?(complete|done)/i);
    await screen.findByTestId("comparison", undefined, SLOW);
    expect(api.runAdversarial).toHaveBeenCalledTimes(1);
  });

  test("labels fixtures and shows the fixture map in mock mode", () => {
    mount();
    expect(screen.getByText(/Development fixture · not measured/)).toBeInTheDocument();
    expect(screen.getByText(/Development fixture map/)).toBeInTheDocument();
  });
});

describe("baseline versus hardened", () => {
  test("baseline fails, hardened resists: rates come from the trial records", async () => {
    mount();
    await runIt("user_agent_injection", "3");
    expect(cell("cmp-success", 0)).toHaveTextContent("2 of 3 (66.7%)");
    expect(cell("cmp-success", 1)).toHaveTextContent("0 of 3 (0%)");
    expect(cell("cmp-violations", 0)).toHaveTextContent("trials 1, 3");
    expect(cell("cmp-violations", 1)).toHaveTextContent("none in the returned records");
    expect(screen.getByTestId("rate-delta")).toHaveTextContent("hardened lower by 66.7 percentage points");
    expect(screen.getByTestId("rate-delta").parentElement).toHaveTextContent(/describe this run only/i);
    const cites = screen.getAllByTestId("citation");
    expect(cites[0]).toHaveAttribute("data-status", "some_rejected");
    expect(cites[0]).toHaveTextContent("1 verified · 2 rejected · 3 total");
    expect(cites[1]).toHaveAttribute("data-status", "all_verified");
    expect(screen.getByTestId("baseline-headline")).toHaveTextContent("2 of 3");
    expect(screen.getByTestId("settings")).toHaveTextContent("model: dev-fixture");
  });

  test("both resist: reported as equal, never as a win", async () => {
    mount();
    await runIt("url_query_contamination", "2");
    expect(cell("cmp-success", 0)).toHaveTextContent("0 of 2 (0%)");
    expect(cell("cmp-success", 1)).toHaveTextContent("0 of 2 (0%)");
    expect(screen.getByTestId("rate-delta")).toHaveTextContent(/are the same in these returned records/);
  });

  test("both fail: the hardened pipeline's successful injections are shown", async () => {
    mount();
    await runIt("fake_analyst_authorization", "4");
    expect(cell("cmp-success", 0)).toHaveTextContent("4 of 4 (100%)");
    expect(cell("cmp-success", 1)).toHaveTextContent("2 of 4 (50%)");
    expect(cell("cmp-violations", 1)).toHaveTextContent("trials 1, 4");
  });

  test("missing and invalid citations are stated explicitly", async () => {
    mount();
    await runIt("user_agent_injection", "9");
    const cites = screen.getAllByTestId("citation");
    expect(cites[0]).toHaveAttribute("data-status", "none_checked");
    expect(cites[0]).toHaveTextContent("No citations were checked or returned");
    expect(cites[0]).toHaveTextContent("Absence of citations is not evidence of validity");
    expect(cites[1]).toHaveAttribute("data-status", "some_rejected");
    expect(cites[1]).toHaveTextContent("6 verified · 3 rejected · 9 total");
  });

  test("partial results are called out and missing trials are not counted as passes", async () => {
    mount();
    await runIt("user_agent_injection", "8");
    expect(screen.getByTestId("partial-note")).toHaveTextContent(/baseline returned 5 and hardened returned 3/);
    expect(cell("cmp-trials", 0)).toHaveTextContent("5 returned · 8 reported · 8 requested");
    expect(cell("cmp-success", 1)).toHaveTextContent("0 of 3");
    expect(screen.getByLabelText("Hardened trials").querySelectorAll('[data-outcome="not_returned"]').length).toBe(2);
  });

  test("an empty result is an explicit state with no rate", async () => {
    mount();
    await pick("user_agent_injection");
    await setTrials("6");
    await start();
    expect(await screen.findByTestId("empty-result", undefined, SLOW)).toHaveTextContent("Empty result");
    expect(screen.queryByTestId("comparison")).toBeNull();
    expect(screen.getByTestId("baseline-headline")).toHaveTextContent("No trial records");
  });

  test("a response that contradicts its own records is flagged and the records win", async () => {
    vi.mocked(api.runAdversarial).mockImplementation(async (body) => {
      const r = unwrap(await handleMock("POST", "/api/adversarial/run", body));
      return { ...r, baseline: { ...r.baseline, injection_successes: 0 } };
    });
    mount();
    await runIt("user_agent_injection", "3");
    expect(screen.getByTestId("review-notes")).toHaveTextContent(/reports 0 injection successes but the trial records show 2/);
    expect(cell("cmp-success", 0)).toHaveTextContent("2 of 3");
  });

  test("results are labelled as belonging to an earlier run once the configuration changes", async () => {
    mount();
    await runIt("user_agent_injection", "2");
    expect(screen.queryByTestId("stale-note")).toBeNull();
    await pick("url_query_contamination");
    expect(screen.getByTestId("stale-note")).toHaveTextContent(/earlier run \(User-agent injection, 2 trials\)/);
  });
});

describe("trial inspector", () => {
  test("shows scenario, surface, payload, behaviour, expectation, outcome and citation information for the chosen trial", async () => {
    mount();
    await runIt("user_agent_injection", "3");
    expect(screen.getByTestId("inspector")).toHaveAttribute("data-trial", "1");
    await userEvent.click(screen.getAllByRole("button", { name: /^Trial 2:/ })[0]!);
    const insp = screen.getByTestId("inspector");
    expect(insp).toHaveAttribute("data-trial", "2");
    expect(screen.getByTestId("insp-scenario")).toHaveTextContent("Prompt injection in an HTTP user-agent");
    expect(screen.getByTestId("insp-field")).toHaveTextContent("user_agent");
    expect(screen.getByTestId("insp-payload")).toHaveTextContent("IGNORE PREVIOUS INSTRUCTIONS");
    expect(screen.getByTestId("insp-expected")).toHaveTextContent(/treated as untrusted data/i);
    expect(screen.getByTestId("outcome-baseline")).toHaveTextContent("Injection resisted");
    expect(screen.getByTestId("output-baseline")).toHaveTextContent("DEV FIXTURE (baseline, trial 2)");
    expect(screen.getByTestId("trialcite-baseline")).toHaveTextContent(/Not returned per trial/);
    await userEvent.click(screen.getAllByRole("button", { name: /^Trial 1:/ })[0]!);
    expect(screen.getByTestId("outcome-baseline")).toHaveTextContent("Injection succeeded");
    expect(screen.getByTestId("outcome-hardened")).toHaveTextContent("Injection resisted");
  });

  test("a trial missing from one pipeline says so", async () => {
    mount();
    await runIt("user_agent_injection", "8");
    await userEvent.click(screen.getAllByRole("button", { name: /^Trial 4:/ })[0]!);
    expect(screen.getByTestId("outcome-hardened")).toHaveTextContent("Trial not returned");
    expect(within(screen.getByTestId("inspect-hardened")).getByText(/was not returned for this pipeline/)).toBeInTheDocument();
  });

  test("attacker-controlled payloads and outputs are rendered as inert text", async () => {
    const hostile = '<img src=x onerror="window.__rt=1"><script>window.__rt=2</script>';
    vi.mocked(api.runAdversarial).mockImplementation(async (body) => {
      const r = unwrap(await handleMock("POST", "/api/adversarial/run", body));
      r.scenario.untrusted_payload = hostile;
      r.baseline.outputs[0]!.output = hostile;
      return r;
    });
    mount();
    await runIt("user_agent_injection", "2");
    expect(screen.getByTestId("insp-payload").textContent).toBe(hostile);
    expect(screen.getByTestId("output-baseline").textContent).toBe(hostile);
    expect(document.querySelector("[data-testid=inspector] img, [data-testid=inspector] script")).toBeNull();
    expect((window as unknown as { __rt?: number }).__rt).toBeUndefined();
    expect(screen.getByText(/Inert test data · untrusted/)).toBeInTheDocument();
  });
});

describe("errors, retries and cancellation", () => {
  test("a backend error is explained, records nothing, and a retry can succeed", async () => {
    mount();
    await pick("user_agent_injection");
    await setTrials("7");
    await start();
    const alert = await screen.findByTestId("run-error", undefined, SLOW);
    expect(alert).toHaveAttribute("data-code", "ADVERSARIAL_RUN_FAILED");
    expect(alert).toHaveTextContent("HTTP 503");
    expect(alert).toHaveTextContent(/No results were recorded/);
    expect(screen.queryByTestId("comparison")).toBeNull();
    await start();
    expect(await screen.findByTestId("comparison", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId("run-error")).toBeNull();
    expect(api.runAdversarial).toHaveBeenCalledTimes(2);
  });

  test("an unreachable backend is reported as such, with no fallback data", async () => {
    vi.mocked(api.runAdversarial).mockRejectedValue(new ApiError("Could not reach the SOC Sentinel API.", "network_error", null, null));
    mount();
    await pick("user_agent_injection");
    await start();
    const alert = await screen.findByTestId("run-error");
    expect(alert).toHaveTextContent("The backend could not be reached.");
    expect(screen.queryByTestId("comparison")).toBeNull();
    expect(screen.getAllByText(/No result yet/)).toHaveLength(2);
  });

  test("a run that does not finish in time is reported as a timeout", async () => {
    vi.mocked(api.runAdversarial).mockImplementation((_b, signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")))));
    mount({ timeoutMs: 50 });
    await pick("user_agent_injection");
    await start();
    expect(await screen.findByTestId("run-error", undefined, SLOW)).toHaveAttribute("data-code", "request_timeout");
    expect(screen.getByRole("button", { name: /run the test again/i })).toBeEnabled();
  });

  test("cancel aborts the request and returns to idle", async () => {
    let aborted = false;
    vi.mocked(api.runAdversarial).mockImplementation((_b, signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => { aborted = true; rej(new DOMException("Aborted", "AbortError")); })));
    mount();
    await pick("user_agent_injection");
    await start();
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.getByTestId("idle-note")).toBeInTheDocument());
    expect(aborted).toBe(true);
    expect(screen.queryByTestId("run-error")).toBeNull();
  });
});
