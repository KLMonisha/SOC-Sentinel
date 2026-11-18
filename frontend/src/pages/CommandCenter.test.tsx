import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { CaseSummary, UploadResponse } from "@/api/types";
import { CommandCenter } from "./CommandCenter";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { listCases: vi.fn(), upload: vi.fn() } };
});
import { api } from "@/api/client";

const score = (value: number, band: "low" | "investigate" | "high") => ({ value, band, reasoning: [] });
const mk = (id: string, title: string, severity: CaseSummary["severity"], value: number): CaseSummary => ({
  case_id: id, dataset_id: "ds1", title, status: "open", verdict: "needs_investigation",
  risk_score: score(value, "investigate"), severity, primary_entities: ["alice"],
  event_count: 3, first_seen: "2026-11-18T10:00:00Z", last_seen: "2026-11-18T10:05:00Z",
});
const CASES = [mk("c1", "Low thing", "low", 10), mk("c2", "Brute force on alice", "critical", 80)];
const envelope = { schema_version: "1.0", request_id: "r1" };

function renderPage() {
  return render(<MemoryRouter><CommandCenter /></MemoryRouter>);
}

beforeEach(() => vi.resetAllMocks());

describe("Command Center", () => {
  test("shows empty state when there are no cases", async () => {
    vi.mocked(api.listCases).mockResolvedValue({ ...envelope, cases: [] });
    renderPage();
    expect(await screen.findByText("No cases yet")).toBeInTheDocument();
  });

  test("shows the API error with request id and retries", async () => {
    vi.mocked(api.listCases)
      .mockRejectedValueOnce(new ApiError("Backend down", "network_error", 503, "req-42"))
      .mockResolvedValueOnce({ ...envelope, cases: CASES });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend down");
    expect(screen.getByRole("alert")).toHaveTextContent("req-42");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Brute force on alice")).toBeInTheDocument();
  });

  test("orders by severity and filters by search text", async () => {
    vi.mocked(api.listCases).mockResolvedValue({ ...envelope, cases: CASES });
    renderPage();
    await screen.findByText("Low thing");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Brute force on alice");
    await userEvent.type(screen.getByRole("textbox", { name: /search cases/i }), "low");
    expect(screen.queryByText("Brute force on alice")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: /search cases/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /search cases/i }), "zzz");
    expect(screen.getByText("No cases match")).toBeInTheDocument();
  });

  test("rejects unsupported file types without calling the API", async () => {
    vi.mocked(api.listCases).mockResolvedValue({ ...envelope, cases: [] });
    renderPage();
    await screen.findByText("No cases yet");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["x"], "notes.txt", { type: "text/plain" }), { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(/unsupported file type/i);
    expect(api.upload).not.toHaveBeenCalled();
  });

  test("successful upload shows backend counts and quarantined rows, then reloads the queue", async () => {
    vi.mocked(api.listCases).mockResolvedValue({ ...envelope, cases: CASES });
    const upload: UploadResponse = {
      ...envelope, dataset_id: "ds1", filename: "auth.csv", file_sha256: "a".repeat(64),
      counts: { total_records: 12, valid_events: 10, quarantined_records: 2 },
      validation_errors: [{ row_number: 4, reason: "invalid timestamp" }],
      cases: CASES,
    };
    vi.mocked(api.upload).mockResolvedValue(upload);
    renderPage();
    await screen.findByText("Low thing");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["a,b"], "auth.csv", { type: "text/csv" }));
    expect(await screen.findByText("invalid timestamp")).toBeInTheDocument();
    expect(screen.getByText("Events processed").nextSibling).toHaveTextContent("10");
    await waitFor(() => expect(api.listCases).toHaveBeenCalledTimes(2));
  });
});
