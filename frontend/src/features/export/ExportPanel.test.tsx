import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ambiguousCase, bruteForceCase, bruteForceReport } from "@/api/mocks/fixtures";
import type { CaseDetail, CounterfactualResponse } from "@/api/types";
import { recordCounterfactual, resetCounterfactualSessions } from "@/features/counterfactual/session";
import { resetSessions } from "@/features/investigation/model";
import { EvidenceRoom } from "@/pages/EvidenceRoom";
import { ReportPage } from "@/pages/ReportPage";
import { MOCK_WATERMARK } from "./common";
import { ExportPanel, exportAvailability } from "./ExportPanel";

const cfg = vi.hoisted(() => ({ config: { useMocks: true, apiBaseUrl: "", redTeamTimeoutMs: 90000 } }));
vi.mock("@/lib/config", () => cfg);
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getCase: vi.fn(), getReport: vi.fn(), decide: vi.fn() } };
});
import { api } from "@/api/client";

// React Flow needs layout; the Evidence Room tests elsewhere use the same stand-in.
vi.mock("@/features/evidence/Constellation", () => ({ Constellation: () => <div data-testid="graph" /> }));

const clone = <T,>(x: T): T => structuredClone(x);
let downloads: { name: string; blob: Blob }[] = [];
let lastBlob: Blob | null = null;

beforeEach(() => {
  vi.resetAllMocks();
  cfg.config.useMocks = true;
  resetSessions();
  resetCounterfactualSessions();
  downloads = [];
  lastBlob = null;
  vi.mocked(api.getCase).mockResolvedValue(clone(bruteForceCase));
  vi.mocked(api.getReport).mockResolvedValue(clone(bruteForceReport));
  URL.createObjectURL = vi.fn((b: Blob) => { lastBlob = b; return "blob:test"; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: lastBlob! });
  });
});
afterEach(() => vi.restoreAllMocks());

const panel = (c: CaseDetail = bruteForceCase, getReport?: () => Promise<typeof bruteForceReport>) =>
  render(<ExportPanel detail={c} getReport={getReport ?? (async () => clone(bruteForceReport))} />);
const btn = (name: RegExp) => screen.getByRole("button", { name });
const textOf = async (b: Blob) => new TextDecoder().decode(await b.arrayBuffer());

describe("export availability", () => {
  test("pure rules: everything is available for a full case; unavailable items explain why", () => {
    const full = exportAvailability(clone(bruteForceCase));
    expect(full.events.available && full.findings.available && full.graph.available && full.report.available).toBe(true);
    expect(full.decisions.available).toBe(false);
    expect(full.decisions.reason).toMatch(/No analyst decision/);
    const empty = clone(ambiguousCase);
    empty.events = []; empty.findings = []; empty.graph = { nodes: [], edges: [] }; empty.missing_evidence = [];
    const a = exportAvailability(empty);
    expect([a.events.available, a.findings.available, a.graph.available]).toEqual([false, false, false]);
    expect(a.events.reason).toMatch(/no source events/);
  });
});

describe("Export interface", () => {
  test("lists each artifact with its format and filename pattern, and labels mock data", () => {
    panel();
    const items = screen.getAllByRole("listitem").filter((li) => li.getAttribute("data-testid")?.startsWith("export-") && !li.getAttribute("data-testid")!.includes("-", 7));
    expect(items.map((i) => i.getAttribute("data-testid"))).toEqual(["export-report", "export-events", "export-findings", "export-decisions", "export-graph"]);
    expect(screen.getByTestId("export-report-name")).toHaveTextContent("DEVFIXTURE_soc-sentinel_case_bf_<UTC time>_report.pdf");
    expect(screen.getByTestId("export-events-name")).toHaveTextContent(/_events\.csv$/);
    expect(screen.getByTestId("export-graph-name")).toHaveTextContent(/_graph\.png$/);
    expect(screen.getByTestId("export-mock-note")).toHaveTextContent(MOCK_WATERMARK);
    expect(screen.getByText(/combined ZIP package .* not available yet/i)).toBeInTheDocument();
  });

  test("an unavailable export is disabled and says why; no download happens", async () => {
    panel();
    const d = btn(/Download Analyst decision audit as CSV/);
    expect(d).toBeDisabled();
    expect(d).toHaveAttribute("aria-describedby", "export-decisions-why");
    expect(screen.getByTestId("export-decisions-why")).toHaveTextContent(/No analyst decision has been recorded/);
    await userEvent.click(d);
    expect(downloads).toHaveLength(0);
  });

  test("the report line states plainly that session-only sections are left out when they do not exist", () => {
    panel();
    expect(screen.getByTestId("export-report-includes")).toHaveTextContent(/left out rather than invented/);
  });
});

describe("downloads", () => {
  test("events CSV: correct filename and real, readable content", async () => {
    panel();
    await userEvent.click(btn(/Download Source events as CSV/));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.name).toMatch(/^DEVFIXTURE_soc-sentinel_case_bf_\d{8}T\d{6}Z_events\.csv$/);
    const text = await textOf(downloads[0]!.blob);
    expect(text).toContain('"data_source","case_id"');
    expect(text).toContain('"mock","case_bf"');
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(bruteForceCase.events.length + 1);
    expect(screen.getByTestId("export-events-done")).toHaveTextContent(/Downloaded .*_events\.csv/);
  });

  test("live data is not labelled as mock", async () => {
    cfg.config.useMocks = false;
    panel();
    expect(screen.queryByTestId("export-mock-note")).toBeNull();
    await userEvent.click(btn(/Download Findings as CSV/));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.name).toMatch(/^soc-sentinel_case_bf_/);
    expect(await textOf(downloads[0]!.blob)).toContain('"live","case_bf"');
  });

  test("PDF: a real watermarked PDF that includes a session counterfactual when one ran", async () => {
    recordCounterfactual("case_bf", {
      excludedEventId: "evt_0007", reason: "r", at: "t",
      res: { original: { verdict: "likely_malicious", risk_score: { value: 70, band: "high", reasoning: [] }, confidence: { level: "medium", rationale: "" }, findings: [], graph: { nodes: [], edges: [] } }, recomputed: { verdict: "needs_investigation", risk_score: { value: 45, band: "investigate", reasoning: [] }, confidence: { level: "low", rationale: "" }, findings: [], graph: { nodes: [], edges: [] } }, score_delta: -25, added: [], removed: [], changed: [], explanation: "e", case_id: "case_bf", schema_version: "1.0", request_id: "r" } as CounterfactualResponse,
    });
    panel();
    expect(screen.getByTestId("export-report-includes")).toHaveTextContent(/a counterfactual run/);
    await userEvent.click(btn(/Download Forensic investigation report as PDF/));
    await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 8000 });
    expect(downloads[0]!.name).toMatch(/_report\.pdf$/);
    const bytes = new Uint8Array(await downloads[0]!.blob.arrayBuffer());
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toContain(MOCK_WATERMARK);
    expect(raw).toContain("Counterfactual analysis");
    expect(raw).toContain("HYPOTHETICAL");
    expect(bytes.length).toBeGreaterThan(5000);
  });

  test("PNG: encodes the canvas and downloads it; a browser that cannot draw gets an explained error", async () => {
    const noop = () => undefined;
    const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 5 }) : noop), set: () => true });
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) { cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })); });
    panel();
    await userEvent.click(btn(/Download Evidence constellation as PNG/));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.name).toMatch(/_graph\.png$/);
    expect(spy).toHaveBeenCalled();
  });

  test("PNG failure is reported and can be retried", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    panel();
    await userEvent.click(btn(/Download Evidence constellation as PNG/));
    expect(await screen.findByTestId("export-graph-error")).toHaveTextContent(/could not create a drawing surface/);
    expect(downloads).toHaveLength(0);
    expect(btn(/Download Evidence constellation as PNG/)).toBeEnabled();
  });

  test("a failing report read is explained and recoverable", async () => {
    let n = 0;
    panel(bruteForceCase, async () => { if (n++ === 0) throw new ApiError("Report not found", "NOT_FOUND", 404, "r"); return clone(bruteForceReport); });
    await userEvent.click(btn(/Download Forensic investigation report as PDF/));
    expect(await screen.findByTestId("export-report-error")).toHaveTextContent(/Report not found/);
    await userEvent.click(btn(/Download Forensic investigation report as PDF/));
    await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 8000 });
    expect(screen.queryByTestId("export-report-error")).toBeNull();
  });

  test("a double click downloads once", async () => {
    panel();
    await userEvent.dblClick(btn(/Download Source events as CSV/));
    await waitFor(() => expect(downloads.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(downloads).toHaveLength(1);
  });
});

describe("where the interface appears", () => {
  test("Report page has an Export section with the same artifacts", async () => {
    vi.mocked(api.getReport).mockResolvedValue(clone(bruteForceReport));
    render(<MemoryRouter initialEntries={["/r"]}><Routes><Route path="/r" element={<ReportPage />} /></Routes></MemoryRouter>);
    const sec = (await screen.findByRole("heading", { name: /Export investigation/i })).closest("section")!;
    expect(within(sec).getByRole("button", { name: /Download Forensic investigation report as PDF/ })).toBeEnabled();
    expect(within(sec).getByRole("button", { name: /Download Evidence constellation as PNG/ })).toBeInTheDocument();
  });

  test("Evidence Room has an Export tab and a header Export action that opens it; PDF fetches the report on demand", async () => {
    render(<MemoryRouter initialEntries={["/evidence/case_bf"]}><Routes><Route path="/evidence/:caseId" element={<EvidenceRoom />} /></Routes></MemoryRouter>);
    await screen.findByTestId("graph");
    expect(screen.queryByTestId("export-panel")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Export" }));
    expect(await screen.findByTestId("export-panel")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    expect(screen.queryByTestId("export-panel")).toBeNull();
    Element.prototype.scrollIntoView = vi.fn();
    await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    expect(await screen.findByTestId("export-panel")).toBeInTheDocument();
    await userEvent.click(btn(/Download Forensic investigation report as PDF/));
    await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 8000 });
    expect(api.getReport).toHaveBeenCalledWith("case_bf");
  });
});
