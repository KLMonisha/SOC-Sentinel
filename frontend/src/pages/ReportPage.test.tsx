import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { bruteForceCase, bruteForceReport } from "@/api/mocks/fixtures";
import type { ReportResponse } from "@/api/types";
import { ReportPage } from "./ReportPage";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getReport: vi.fn(), getCase: vi.fn(), decide: vi.fn() } };
});
import { api } from "@/api/client";

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/app/evidence/case_bf/report"]}>
      <Routes>
        <Route path="/app/evidence/:caseId/report" element={<ReportPage />} />
      </Routes>
    </MemoryRouter>,
  );

const reportWith = (over: Partial<ReportResponse>): ReportResponse => ({ ...structuredClone(bruteForceReport), ...over });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getCase).mockResolvedValue(structuredClone(bruteForceCase));
  vi.mocked(api.getReport).mockResolvedValue(structuredClone(bruteForceReport));
});

describe("Report page", () => {
  test("renders every report section with the stored summary and rationale", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: /Executive summary/i })).toBeInTheDocument();
    for (const name of [/Verdict and confidence/, /Supporting evidence/, /Contradicting evidence/, /Missing telemetry/, /MITRE ATT&CK/, /Chronology/, /^Containment$/, /Claims and citations/, /Analyst decision and audit/]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(bruteForceReport.summary)).toBeInTheDocument();
    expect(screen.getByText(bruteForceReport.verdict_rationale)).toBeInTheDocument();
  });

  test("reads the stored report once and does not regenerate it on render", async () => {
    mount();
    await screen.findByRole("heading", { name: /Executive summary/i });
    expect(api.getReport).toHaveBeenCalledTimes(1);
    expect(api.getCase).toHaveBeenCalledTimes(1);
  });

  test("keeps risk, confidence and coverage as separate readouts and calls risk a heuristic", async () => {
    mount();
    const verdict = (await screen.findByRole("heading", { name: /Verdict and confidence/i })).closest("section")!;
    expect(within(verdict).getByText(/Risk \(heuristic\)/i)).toBeInTheDocument();
    expect(within(verdict).getByText("Confidence")).toBeInTheDocument();
    expect(within(verdict).getByText("Coverage")).toBeInTheDocument();
    expect(within(verdict).getByText(/Not a probability/i)).toBeInTheDocument();
  });

  test("a resolved citation links to the Evidence Room with that exact event selected", async () => {
    mount();
    const claims = (await screen.findByRole("heading", { name: /Claims and citations/i })).closest("section")!;
    const link = within(claims).getAllByRole("link", { name: /evt_0001/ })[0]!;
    expect(link).toHaveAttribute("href", "/app/evidence/case_bf?event=evt_0001");
  });

  test("an unresolved citation is flagged explicitly, is not a link, and is never silently dropped", async () => {
    vi.mocked(api.getReport).mockResolvedValue(reportWith({
      claims: [{ claim_id: "c9", text: "A login happened.", citations: ["evt_0001", "evt_9999"], verified: false, verification_note: "Citation did not resolve." }],
    }));
    mount();
    const claims = (await screen.findByRole("heading", { name: /Claims and citations/i })).closest("section")!;
    expect(within(claims).getByText(/unresolved citation/i)).toBeInTheDocument();
    expect(within(claims).getByText("evt_9999")).toBeInTheDocument();
    expect(within(claims).queryByRole("link", { name: /evt_9999/ })).not.toBeInTheDocument();
    expect(within(claims).getByText("Citation did not resolve.")).toBeInTheDocument();
    expect(within(claims).getByText(/Unverified claim/i)).toBeInTheDocument();
    expect(within(claims).getByText(/not verified and shown for transparency/i)).toBeInTheDocument();
  });

  test("a claim with no citations is called out", async () => {
    vi.mocked(api.getReport).mockResolvedValue(reportWith({ claims: [{ claim_id: "c1", text: "Something.", citations: [], verified: false, verification_note: null }] }));
    mount();
    expect(await screen.findByText(/cites no source event/i)).toBeInTheDocument();
  });

  test("shows how the report was generated", async () => {
    mount();
    expect(await screen.findByText(/Template fallback/i)).toBeInTheDocument();
    vi.mocked(api.getReport).mockResolvedValue(reportWith({ generated_by: "llm" }));
    mount();
    expect(await screen.findByText(/LLM narrative/i)).toBeInTheDocument();
  });

  test("states the containment recommendation is a dry run", async () => {
    mount();
    const sec = (await screen.findByRole("heading", { name: /^Containment$/i })).closest("section")!;
    expect(within(sec).getByRole("note")).toHaveTextContent("DRY RUN — NO LIVE CONTAINMENT EXECUTED");
    expect(within(sec).getByText(bruteForceCase.containment!.action)).toBeInTheDocument();
  });

  test("chronology lists the case's events in order and links each to its evidence", async () => {
    mount();
    const sec = (await screen.findByRole("heading", { name: /Chronology/i })).closest("section")!;
    const rows = within(sec).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(bruteForceCase.events.length);
    expect(rows[0]).toHaveTextContent("evt_0001");
    // same-timestamp events keep a stable order (file, then line)
    const ids = rows.map((r) => /evt_\d+/.exec(r.textContent ?? "")![0]);
    expect(ids.indexOf("evt_0008")).toBeLessThan(ids.indexOf("evt_0007"));
  });

  test("shows contradicting evidence, and states plainly when there is none", async () => {
    mount();
    const sec = (await screen.findByRole("heading", { name: /Contradicting evidence/i })).closest("section")!;
    expect(within(sec).getByText(/Concurrent login from an internal address/)).toBeInTheDocument();
    vi.mocked(api.getCase).mockResolvedValue({ ...structuredClone(bruteForceCase), findings: bruteForceCase.findings.filter((f) => f.stance === "supporting") });
    mount();
    expect((await screen.findAllByText(/recorded no contradicting findings/i)).length).toBeGreaterThan(0);
  });

  test("an API failure shows the error with its request id and can be retried", async () => {
    vi.mocked(api.getReport).mockRejectedValueOnce(new ApiError("Report unavailable", "http_error", 500, "req-7"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("req-7");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
