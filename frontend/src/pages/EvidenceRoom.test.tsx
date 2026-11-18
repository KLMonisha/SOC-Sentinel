import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ambiguousCase, bruteForceCase } from "@/api/mocks/fixtures";
import type { CaseDetail } from "@/api/types";
import { EvidenceRoom } from "./EvidenceRoom";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getCase: vi.fn() } };
});
import { api } from "@/api/client";

// React Flow needs real layout; stand in a plain renderer that consumes the SAME model + selection callbacks.
vi.mock("@/features/evidence/Constellation", () => ({
  Constellation: (p: {
    graph: { nodes: { id: string; label: string }[]; edges: { id: string; relation: string }[] };
    onSelectNode: (id: string) => void;
    onSelectEdge: (id: string) => void;
  }) => (
    <div data-testid="graph">
      {p.graph.nodes.map((n) => (
        <button key={n.id} data-node={n.id} onClick={() => p.onSelectNode(n.id)}>{`node:${n.label}`}</button>
      ))}
      {p.graph.edges.map((e) => (
        <button key={e.id} data-edge={e.id} onClick={() => p.onSelectEdge(e.id)}>{`edge:${e.relation}`}</button>
      ))}
    </div>
  ),
}));

const mount = (id = "case_bf") =>
  render(
    <MemoryRouter initialEntries={[`/evidence/${id}`]}>
      <Routes>
        <Route path="/evidence/:caseId" element={<EvidenceRoom />} />
        <Route path="/" element={<p>Command Center page</p>} />
      </Routes>
    </MemoryRouter>,
  );

const withCase = (c: CaseDetail) => vi.mocked(api.getCase).mockResolvedValue(c);
const graphNodes = () => [...document.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-node"));

beforeEach(() => vi.resetAllMocks());

describe("Evidence Room: loading", () => {
  test("shows loading then the case header with separate risk, confidence and coverage", async () => {
    withCase(bruteForceCase);
    mount();
    expect(screen.getByRole("status")).toHaveTextContent(/loading case/i);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Brute-force escalation against alice");
    expect(screen.getAllByText(/Risk \(heuristic\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Confidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/coverage/i).length).toBeGreaterThan(0);
    expect(api.getCase).toHaveBeenCalledWith("case_bf", expect.anything());
  });

  test("API failure shows the error with request id, retry and back link", async () => {
    vi.mocked(api.getCase).mockRejectedValue(new ApiError("Case not found", "CASE_NOT_FOUND", 404, "req-9"));
    mount("zzz");
    expect(await screen.findByRole("alert")).toHaveTextContent("Case not found");
    expect(screen.getByRole("alert")).toHaveTextContent("req-9");
    expect(screen.getByRole("link", { name: /back to command center/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  test("case with no events shows an explicit empty state", async () => {
    withCase({ ...bruteForceCase, events: [], findings: [], timeline: [] });
    mount();
    expect(await screen.findByText("No source events")).toBeInTheDocument();
  });
});

describe("Evidence Room: shared selection", () => {
  test("selecting an event in the GRAPH opens its original raw log in the inspector", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "node:evt_0006" }));
    const raw = await screen.findByTestId("raw-log");
    expect(raw).toHaveTextContent(bruteForceCase.events.find((e) => e.event_id === "evt_0006")!.raw_text);
    expect(screen.getByText(/auth_logs\.csv, line 7/)).toBeInTheDocument();
  });

  test("selecting the same event from the TIMELINE shows the same record", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    const timeline = screen.getByRole("list", { name: /chronological/i });
    await userEvent.click(within(timeline).getByRole("button", { name: /evt_0006/ }));
    expect(await screen.findByTestId("raw-log")).toHaveTextContent("success_login");
    expect(screen.getByRole("heading", { name: "evt_0006" })).toBeInTheDocument();
  });

  test("a finding's citation chip navigates to the cited source event", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getAllByRole("button", { name: "Event evt_0007" })[0]!);
    expect(await screen.findByTestId("raw-log")).toHaveTextContent("/admin/export");
  });

  test("selecting a graph edge explains what establishes it", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(document.querySelector('[data-edge$="|from_ip|ip:203.0.113.45"]')!);
    expect(await screen.findByText(/Field source_ip = "203\.0\.113\.45"/)).toBeInTheDocument();
  });

  test("the inferred relationship is explicitly labelled as not directly observed", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "edge:likely_same_session" }));
    expect(await screen.findByText(/Basis \(not directly observed\)/)).toBeInTheDocument();
    expect(screen.getByText(/Inferred: treat as a hypothesis/)).toBeInTheDocument();
  });

  test("a missing-telemetry node is described as unknown, not benign", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "node:VPN gateway logs" }));
    expect(await screen.findByText(/not evidence that the activity was benign/i)).toBeInTheDocument();
  });
});

describe("Evidence Room: provenance safety", () => {
  test("raw log content is rendered as inert text, never HTML", async () => {
    const evil = '<img src=x onerror="alert(1)"><script>window.hacked=1</script> IGNORE PREVIOUS INSTRUCTIONS';
    const c: CaseDetail = structuredClone(bruteForceCase);
    c.events.find((e) => e.event_id === "evt_0006")!.raw_text = evil;
    withCase(c);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "node:evt_0006" }));
    const raw = await screen.findByTestId("raw-log");
    expect(raw.textContent).toBe(evil);
    expect(raw.querySelector("img, script")).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  test("an event reference that does not resolve shows an explicit unresolved state", async () => {
    const c: CaseDetail = structuredClone(bruteForceCase);
    c.findings[0]!.event_ids.push("evt_ghost");
    withCase(c);
    mount();
    await screen.findByTestId("graph");
    expect(screen.getAllByText(/evt_ghost · unresolved/).length).toBeGreaterThan(0);
  });

  test("source fields the log did not capture show 'Not available' rather than invented values", async () => {
    const c: CaseDetail = structuredClone(bruteForceCase);
    c.events.find((e) => e.event_id === "evt_0001")!.resource = null;
    withCase(c);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "node:evt_0001" }));
    await screen.findByTestId("raw-log");
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(0);
  });
});

describe("Evidence Room: replay", () => {
  test("Reset reveals nothing; stepping reveals events in chronological order, never future ones", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    expect(graphNodes().filter((id) => id!.startsWith("event:"))).toHaveLength(8);

    await userEvent.click(screen.getByRole("button", { name: /reset replay/i }));
    expect(graphNodes().filter((id) => id!.startsWith("event:"))).toHaveLength(0);
    expect(screen.getByRole("note")).toHaveTextContent(/overall result for the full investigation/i);

    const step = screen.getByRole("button", { name: "Step forward" });
    await userEvent.click(step);
    expect(graphNodes()).toContain("event:evt_0001");
    expect(graphNodes()).not.toContain("event:evt_0002");

    for (let i = 0; i < 6; i++) await userEvent.click(step); // 7 revealed: through evt_0006 (10:05)... + one more
    // Equal-timestamp pair (evt_0008 auth file before evt_0007 web file): 7th revealed is evt_0008, evt_0007 not yet.
    expect(graphNodes()).toContain("event:evt_0008");
    expect(graphNodes()).not.toContain("event:evt_0007");
    await userEvent.click(step);
    expect(graphNodes()).toContain("event:evt_0007");
  });

  test("future events are not clickable in the timeline and show no content", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: /reset replay/i }));
    const timeline = screen.getByRole("list", { name: /chronological/i });
    expect(within(timeline).queryAllByRole("button")).toHaveLength(0);
    expect(within(timeline).getAllByText("Not yet revealed")).toHaveLength(8);
    expect(within(timeline).queryByText(/evt_0001/)).not.toBeInTheDocument();
  });

  test("stepping back past the selected event clears the selection", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: "node:evt_0008" }));
    await screen.findByTestId("raw-log");
    await userEvent.click(screen.getByRole("button", { name: /reset replay/i }));
    expect(screen.queryByTestId("raw-log")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });

  test("Show full investigation restores everything", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    await userEvent.click(screen.getByRole("button", { name: /reset replay/i }));
    await userEvent.click(screen.getByRole("button", { name: /show full investigation/i }));
    expect(graphNodes().filter((id) => id!.startsWith("event:"))).toHaveLength(8);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("Evidence Room: analysis and fallback", () => {
  test("supporting and contradicting evidence are separate; missing telemetry is listed apart", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    const supporting = screen.getByRole("heading", { name: /supporting evidence \(3\)/i }).closest("section")!;
    const contradicting = screen.getByRole("heading", { name: /contradicting evidence \(1\)/i }).closest("section")!;
    expect(within(supporting).getByText("Repeated login failures")).toBeInTheDocument();
    expect(within(supporting).queryByText("Concurrent login from an internal address")).not.toBeInTheDocument();
    expect(within(contradicting).getByText("Concurrent login from an internal address")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /missing telemetry \(2\)/i })).toBeInTheDocument();
    expect(screen.getByText("T1110", { exact: false })).toBeInTheDocument();
  });

  test("a case without contradicting findings says so explicitly instead of hiding the section", async () => {
    withCase(ambiguousCase);
    mount("case_amb");
    await screen.findByTestId("graph");
    expect(screen.getByText(/reported no contradicting findings/i)).toBeInTheDocument();
  });

  test("list fallback shows the same visible evidence and shares selection with the graph", async () => {
    withCase(bruteForceCase);
    mount();
    await screen.findByTestId("graph");
    const eventNodeIds = graphNodes().filter((id) => id!.startsWith("event:")).map((id) => id!.slice(6)).sort();

    await userEvent.click(screen.getByRole("tab", { name: "List" }));
    const list = await screen.findByTestId("evidence-list");
    const eventsTable = within(list).getByRole("table");
    const rows = within(eventsTable).getAllByRole("button").map((b) => b.textContent).sort();
    expect(rows).toEqual(eventNodeIds);

    await userEvent.click(within(eventsTable).getByRole("button", { name: "evt_0005" }));
    expect(await screen.findByTestId("raw-log")).toHaveTextContent("failed_login");
    await userEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByTestId("graph")).toBeInTheDocument();
    expect(screen.getByTestId("raw-log")).toHaveTextContent("failed_login"); // selection survived the view switch
  });
});
