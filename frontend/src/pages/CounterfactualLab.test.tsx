import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { bruteForceCase } from "@/api/mocks/fixtures";
import { handleMock } from "@/api/mocks/handler";
import type { CaseDetail, CounterfactualResponse } from "@/api/types";
import { CounterfactualIndex } from "./CounterfactualIndex";
import { CounterfactualLab } from "./CounterfactualLab";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getCase: vi.fn(), counterfactual: vi.fn(), listCases: vi.fn() } };
});
import { api } from "@/api/client";

const mount = (search = "") =>
  render(
    <MemoryRouter initialEntries={[`/app/counterfactual/case_bf${search}`]}>
      <Routes>
        <Route path="/app/counterfactual/:caseId" element={<CounterfactualLab />} />
      </Routes>
    </MemoryRouter>,
  );

/** Route the lab's counterfactual call through the dev mock so verdicts/diffs come from the contract-shaped handler. */
const viaMock = () =>
  vi.mocked(api.counterfactual).mockImplementation(async (id, body) => {
    const r = await handleMock("POST", `/api/cases/${id}/counterfactual`, body);
    if (r.status >= 400) {
      const e = (r.data as { error: { code: string; message: string } }).error;
      throw new ApiError(e.message, e.code, r.status, "req-x");
    }
    return r.data as CounterfactualResponse;
  });

const pick = (id: string) => userEvent.click(document.querySelector(`[data-event-id="${id}"]`) as HTMLElement);
const reasonBox = () => screen.getByLabelText(/^reason/i);
const runBtn = () => screen.getByRole("button", { name: /recompute without this event/i });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getCase).mockImplementation(async () => structuredClone(bruteForceCase));
  viaMock();
});

describe("Counterfactual Lab: before running", () => {
  test("shows the stored case as the original, an empty branch, and only the supported operation", async () => {
    mount();
    expect(await screen.findByTestId("original-verdict")).toHaveTextContent("Likely malicious");
    expect(screen.getByTestId("original-risk")).toHaveTextContent("70");
    expect(screen.getByRole("region", { name: /recomputed branch \(not yet available\)/i })).toBeInTheDocument();
    expect(screen.getByText(/operation: exclude event/i)).toBeInTheDocument();
    expect(screen.getByText(/Only exclusion is supported/i)).toBeInTheDocument();
    // unsupported overrides are explained, never offered as controls
    expect(screen.queryByRole("button", { name: /vpn|ioc|maintenance/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /vpn|ioc|maintenance/i })).toBeNull();
  });

  test("lists every event as a radio and arrow keys move the selection", async () => {
    mount();
    await screen.findByTestId("original-verdict");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(bruteForceCase.events.length);
    await pick("evt_0001");
    expect(screen.getByRole("radio", { name: /evt_0001/ })).toBeChecked();
    screen.getByRole("radio", { name: /evt_0001/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /evt_0002/ })).toBeChecked();
  });

  test("selecting an event highlights the stored findings that cite it (a fact about the stored case)", async () => {
    mount();
    await screen.findByTestId("original-verdict");
    await pick("evt_0005");
    expect(screen.getAllByText(/cites evt_0005/i)).toHaveLength(2); // f_bf and f_sa
  });

  test("an event from the URL is preselected; an event not in the case is called out", async () => {
    mount("?event=evt_0003");
    await screen.findByTestId("original-verdict");
    expect(screen.getByRole("radio", { name: /evt_0003/ })).toBeChecked();
  });
  test("an unknown linked event selects nothing and says so", async () => {
    mount("?event=evt_9999");
    expect(await screen.findByText(/linked event evt_9999 is not part of this case/i)).toBeInTheDocument();
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  test("requires an event and a reason, and sends nothing until both are given", async () => {
    mount();
    await screen.findByTestId("original-verdict");
    await userEvent.click(runBtn());
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts.join(" ")).toMatch(/select the event to exclude/i);
    expect(alerts.join(" ")).toMatch(/a reason is required/i);
    expect(api.counterfactual).not.toHaveBeenCalled();
    await pick("evt_0001");
    await userEvent.type(reasonBox(), "   ");
    await userEvent.click(runBtn());
    expect(api.counterfactual).not.toHaveBeenCalled();
  });
});

describe("Counterfactual Lab: results", () => {
  async function runFor(event: string, why = "Confirmed test traffic") {
    mount();
    await screen.findByTestId("original-verdict");
    await pick(event);
    await userEvent.type(reasonBox(), why);
    await userEvent.click(runBtn());
    await screen.findByTestId("recomputed-verdict");
  }

  test("sends exactly one exclude_event override with the trimmed reason", async () => {
    await runFor("evt_0001", "  Confirmed test traffic ");
    expect(api.counterfactual).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.counterfactual).mock.calls[0]![0]).toBe("case_bf");
    expect(vi.mocked(api.counterfactual).mock.calls[0]![1]).toEqual({ overrides: [{ type: "exclude_event", event_id: "evt_0001", reason: "Confirmed test traffic" }] });
  });

  test("a changed verdict is announced, with both outcomes side by side and the original untouched", async () => {
    await runFor("evt_0001");
    expect(screen.getByText(/Verdict changed:/i)).toBeInTheDocument();
    expect(screen.getByTestId("original-verdict")).toHaveTextContent("Likely malicious");
    expect(screen.getByTestId("recomputed-verdict")).toHaveTextContent("Needs investigation");
    expect(screen.getByTestId("original-risk")).toHaveTextContent("70");
    expect(screen.getByTestId("recomputed-risk")).toHaveTextContent("65");
  });

  test("an unchanged verdict is a valid result, explained rather than treated as failure", async () => {
    await runFor("evt_0008"); // only contradicting evidence cites it
    expect(screen.getByText(/Verdict unchanged: Likely malicious/i)).toBeInTheDocument();
    expect(screen.getByText(/valid result/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("groups removed, changed and unchanged findings and keeps coverage honest (not returned)", async () => {
    await runFor("evt_0007");
    const removed = screen.getByRole("heading", { name: /removed findings/i }).parentElement!;
    expect(within(removed).getByText("Sensitive endpoint after login")).toBeInTheDocument();
    expect(within(removed).getByText(/no longer holds/i)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /original versus recomputed outcome/i });
    expect(within(table).getByText(/not returned by the backend/i)).toBeInTheDocument();
    expect(screen.getByTestId("recomputed-verdict").closest("section")).toHaveTextContent(/not returned/i);
  });

  test("shows the backend explanation and links cited evidence back to the stored events", async () => {
    await runFor("evt_0007");
    expect(screen.getByText(/DEV MOCK: simplified stand-in/i)).toBeInTheDocument();
    const link = screen.getAllByRole("link", { name: /evt_0006/ })[0]!;
    expect(link).toHaveAttribute("href", "/app/evidence/case_bf?event=evt_0006");
  });

  test("re-reads the stored case afterwards and reports it unchanged", async () => {
    await runFor("evt_0007");
    expect(await screen.findByText(/stored case was re-read after the run and is unchanged/i)).toBeInTheDocument();
    expect(api.getCase).toHaveBeenCalledTimes(2);
  });

  test("warns loudly if the stored case differs after the run", async () => {
    mount();
    await screen.findByTestId("original-verdict");
    const mutated: CaseDetail = structuredClone(bruteForceCase);
    mutated.summary.risk_score = { ...mutated.summary.risk_score, value: 1 };
    vi.mocked(api.getCase).mockResolvedValueOnce(mutated);
    await pick("evt_0007");
    await userEvent.type(reasonBox(), "why");
    await userEvent.click(runBtn());
    expect(await screen.findByText(/differs from its state before the run/i)).toBeInTheDocument();
  });

  test("flags a response that contradicts the stored case or its own score change, showing values unmodified", async () => {
    mount();
    await screen.findByTestId("original-verdict");
    const real = (await handleMock("POST", "/api/cases/case_bf/counterfactual", { overrides: [{ type: "exclude_event", event_id: "evt_0007", reason: "x" }] })).data as CounterfactualResponse;
    const bad = structuredClone(real);
    bad.score_delta = 7;
    bad.original.risk_score = { ...bad.original.risk_score, value: 50 };
    vi.mocked(api.counterfactual).mockResolvedValue(bad);
    await pick("evt_0007");
    await userEvent.type(reasonBox(), "why");
    await userEvent.click(runBtn());
    expect(await screen.findByText(/does not equal the difference/i)).toBeInTheDocument();
    expect(screen.getByText(/differs from the stored case/i)).toBeInTheDocument();
  });

  test("choosing a different event clears the previous result", async () => {
    await runFor("evt_0007");
    await pick("evt_0002");
    expect(screen.queryByTestId("recomputed-verdict")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /recomputed branch \(not yet available\)/i })).toBeInTheDocument();
  });

  test("offers a way back to the original investigation at the excluded event", async () => {
    await runFor("evt_0007");
    expect(screen.getByRole("link", { name: /back to the original investigation/i })).toHaveAttribute("href", "/app/evidence/case_bf?event=evt_0007");
  });
});

describe("Counterfactual Lab: failures", () => {
  async function fail(err: ApiError) {
    vi.mocked(api.counterfactual).mockRejectedValue(err);
    mount();
    await screen.findByTestId("original-verdict");
    await pick("evt_0001");
    await userEvent.type(reasonBox(), "why");
    await userEvent.click(runBtn());
    return screen.findByRole("alert");
  }

  test("unsupported override", async () => {
    const a = await fail(new ApiError("Override not supported", "UNSUPPORTED_OVERRIDE", 400, "req-1"));
    expect(a).toHaveTextContent(/does not support this override/i);
    expect(a).toHaveTextContent("req-1");
  });
  test("missing event", async () => {
    expect(await fail(new ApiError("Event evt_0001 not in case", "EVENT_NOT_FOUND", 404, "req-2"))).toHaveTextContent(/does not recognise that event/i);
  });
  test("network failure leaves the original intact, shows no result, and allows retry", async () => {
    const a = await fail(new ApiError("Backend down", "network_error", null, null));
    expect(a).toHaveTextContent("Backend down");
    expect(a).toHaveTextContent(/nothing was changed/i);
    expect(screen.queryByTestId("recomputed-verdict")).not.toBeInTheDocument();
    expect(screen.getByTestId("original-verdict")).toHaveTextContent("Likely malicious");
    expect(runBtn()).toBeEnabled();
  });

  test("rapid repeated submits send one request", async () => {
    let resolve!: (v: CounterfactualResponse) => void;
    vi.mocked(api.counterfactual).mockReturnValue(new Promise<CounterfactualResponse>((r) => { resolve = r; }));
    mount();
    await screen.findByTestId("original-verdict");
    await pick("evt_0007");
    await userEvent.type(reasonBox(), "why");
    const btn = runBtn();
    fireEvent.click(btn); fireEvent.click(btn); fireEvent.click(btn);
    expect(api.counterfactual).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/re-running detection, correlation and scoring/i)).toBeInTheDocument();
    resolve((await handleMock("POST", "/api/cases/case_bf/counterfactual", { overrides: [{ type: "exclude_event", event_id: "evt_0007", reason: "x" }] })).data as CounterfactualResponse);
    await screen.findByTestId("recomputed-verdict");
  });

  test("a case without events shows an empty state instead of a broken form", async () => {
    vi.mocked(api.getCase).mockResolvedValue({ ...structuredClone(bruteForceCase), events: [], findings: [] });
    mount();
    expect(await screen.findByText(/nothing to exclude/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /recompute/i })).not.toBeInTheDocument();
  });

  test("a case that cannot be loaded shows the error with its request id", async () => {
    vi.mocked(api.getCase).mockRejectedValue(new ApiError("Not found", "CASE_NOT_FOUND", 404, "req-404"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("req-404");
  });
});

describe("Counterfactual index", () => {
  test("lists cases with links into the lab", async () => {
    vi.mocked(api.listCases).mockResolvedValue({ schema_version: "1.0", request_id: "r", cases: [bruteForceCase.summary] });
    render(<MemoryRouter><CounterfactualIndex /></MemoryRouter>);
    const link = await screen.findByRole("link", { name: /Brute-force escalation/i });
    expect(link).toHaveAttribute("href", "/app/counterfactual/case_bf");
    await waitFor(() => expect(link).toBeVisible());
  });
});
