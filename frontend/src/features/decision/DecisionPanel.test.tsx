import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ambiguousCase, bruteForceCase } from "@/api/mocks/fixtures";
import type { CaseDetail, DecisionRecord } from "@/api/types";
import { AuditHistory } from "./AuditHistory";
import { DRY_RUN_BANNER, DecisionPanel, validateAnalystId } from "./DecisionPanel";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { decide: vi.fn() } };
});
import { api } from "@/api/client";

const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decision_id: "dec_1", case_id: "case_bf", decision: "approve", analyst_id: "priyanka", note: null,
  decided_at: "2026-11-19T04:10:00Z", dry_run: true, ...over,
});
const env = { schema_version: "1.0", request_id: "r" };
const withDecisions = (c: CaseDetail, d: DecisionRecord[]): CaseDetail => ({ ...structuredClone(c), decisions: d });

beforeEach(() => { vi.resetAllMocks(); window.localStorage.clear(); });

describe("validateAnalystId", () => {
  test("requires a non-blank value", () => {
    expect(validateAnalystId("")).not.toBeNull();
    expect(validateAnalystId("   ")).not.toBeNull();
    expect(validateAnalystId(" priyanka ")).toBeNull();
  });
});

describe("DecisionPanel", () => {
  test("always states that containment is a dry run and shows the recommendation", () => {
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent(DRY_RUN_BANNER);
    expect(screen.getByText(bruteForceCase.containment!.action)).toBeInTheDocument();
    expect(screen.getByText(bruteForceCase.containment!.target)).toBeInTheDocument();
  });

  test("blocks submission without an analyst ID and does not call the API", async () => {
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/analyst id is required/i);
    expect(screen.getByLabelText(/analyst id/i)).toHaveAttribute("aria-invalid", "true");
    expect(api.decide).not.toHaveBeenCalled();
  });

  test("approve needs an explicit confirmation, then records exactly one dry-run decision with the trimmed analyst ID", async () => {
    vi.mocked(api.decide).mockResolvedValue({ ...env, record: rec({ note: "ok" }), case_status: "approved" });
    const onDecided = vi.fn();
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={onDecided} />);
    await userEvent.type(screen.getByLabelText(/analyst id/i), "  priyanka ");
    await userEvent.type(screen.getByLabelText(/note/i), "ok");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/APPROVAL/);
    expect(dialog).toHaveTextContent(DRY_RUN_BANNER);
    expect(api.decide).not.toHaveBeenCalled(); // nothing is sent until confirmed

    await userEvent.click(within(dialog).getByRole("button", { name: /confirm approve/i }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
    expect(api.decide).toHaveBeenCalledWith("case_bf", { decision: "approve", analyst_id: "priyanka", note: "ok" });
    expect(await screen.findByText(/Decision recorded: approved by/i)).toHaveTextContent(DRY_RUN_BANNER);
    expect(onDecided).toHaveBeenCalled();
  });

  test("a note is omitted from the request when blank", async () => {
    vi.mocked(api.decide).mockResolvedValue({ ...env, record: rec({ decision: "reject" }), case_status: "rejected" });
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/analyst id/i), "priyanka");
    await userEvent.click(screen.getByRole("button", { name: /reject/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm reject/i }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("case_bf", { decision: "reject", analyst_id: "priyanka" }));
  });

  test("rapid repeated clicks on confirm send one request", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(api.decide).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/analyst id/i), "priyanka");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    const confirm = screen.getByRole("button", { name: /confirm approve/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.decide).toHaveBeenCalledTimes(1);
    resolve({ ...env, record: rec(), case_status: "approved" });
    await screen.findByText(/Decision recorded/i);
  });

  test("backend errors are shown with their request id and nothing is claimed as recorded", async () => {
    vi.mocked(api.decide).mockRejectedValue(new ApiError("analyst_id is required.", "invalid_request", 400, "req-9"));
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/analyst id/i), "x");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm approve/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("analyst_id is required.");
    expect(alert).toHaveTextContent("req-9");
    expect(screen.queryByText(/Decision recorded/i)).not.toBeInTheDocument();
  });

  test("a failed refresh after a successful decision is not reported as a failed decision", async () => {
    vi.mocked(api.decide).mockResolvedValue({ ...env, record: rec(), case_status: "approved" });
    render(<DecisionPanel caseDetail={bruteForceCase} onDecided={() => Promise.reject(new Error("refresh failed"))} />);
    await userEvent.type(screen.getByLabelText(/analyst id/i), "priyanka");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm approve/i }));
    expect(await screen.findByText(/Decision recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("with no containment recommendation there is nothing to approve or reject", () => {
    render(<DecisionPanel caseDetail={ambiguousCase} onDecided={vi.fn()} />);
    expect(screen.getByText(/nothing to approve or reject/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reject/i })).toBeDisabled();
  });

  test("an existing decision history is shown and a further decision is explicitly allowed to be attempted", () => {
    render(<DecisionPanel caseDetail={withDecisions(bruteForceCase, [rec()])} onDecided={vi.fn()} />);
    expect(screen.getByText(/already has 1 recorded decision/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
  });
});

describe("AuditHistory", () => {
  test("lists every decision oldest first, regardless of the order returned, with its dry-run status", () => {
    render(
      <AuditHistory decisions={[
        rec({ decision_id: "dec_2", decision: "reject", analyst_id: "a.moreno", decided_at: "2026-11-19T05:00:00Z", note: "Test traffic" }),
        rec({ decision_id: "dec_1", decision: "approve", analyst_id: "priyanka", decided_at: "2026-11-19T04:00:00Z" }),
      ]} />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("dec_1");
    expect(items[0]).toHaveTextContent(/Approved/);
    expect(items[1]).toHaveTextContent("dec_2");
    expect(items[1]).toHaveTextContent("Test traffic");
    for (const li of items) expect(li).toHaveTextContent(/dry run · nothing executed/i);
  });
  test("says so when no decision exists", () => {
    render(<AuditHistory decisions={[]} />);
    expect(screen.getByText(/no analyst decision has been recorded/i)).toBeInTheDocument();
  });
});
