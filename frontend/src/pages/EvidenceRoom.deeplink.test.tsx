import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { bruteForceCase } from "@/api/mocks/fixtures";
import { EvidenceRoom } from "./EvidenceRoom";

vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return { ...actual, api: { getCase: vi.fn(), decide: vi.fn() } };
});
import { api } from "@/api/client";

vi.mock("@/features/evidence/Constellation", () => ({
  Constellation: (p: { graph: { nodes: { id: string; label: string }[] }; onSelectNode: (id: string) => void }) => (
    <div data-testid="graph">
      {p.graph.nodes.map((n) => <button key={n.id} onClick={() => p.onSelectNode(n.id)}>{`node:${n.label}`}</button>)}
    </div>
  ),
}));

const Probe = () => <output data-testid="search">{useLocation().search}</output>;
const mount = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/app/evidence/case_bf${search}`]}>
      <Routes>
        <Route path="/app/evidence/:caseId" element={<><EvidenceRoom /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getCase).mockResolvedValue(structuredClone(bruteForceCase));
});

describe("Evidence Room deep link (?event=)", () => {
  test("opens with the cited event selected and its raw source log in the inspector", async () => {
    mount("?event=evt_0003");
    const raw = await screen.findByTestId("raw-log");
    expect(raw).toHaveTextContent(bruteForceCase.events.find((e) => e.event_id === "evt_0003")!.raw_text);
    expect(screen.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
  });

  test("an event that is not part of the case is shown as unresolved, never ignored", async () => {
    mount("?event=evt_9999");
    expect(await screen.findByText(/Unresolved event reference/i)).toBeInTheDocument();
    expect(screen.getByText(/does not match any stored event/i)).toBeInTheDocument();
  });

  test("selecting evidence updates the URL so refresh and sharing land on the same event", async () => {
    mount("");
    await screen.findByTestId("graph");
    expect(screen.getByTestId("search")).toHaveTextContent("");
    await userEvent.click(screen.getByRole("button", { name: "node:evt_0005" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?event=evt_0005"));
  });

  test("an event that falls outside a partial replay is revealed when linked to", async () => {
    mount("?event=evt_0007");
    const raw = await screen.findByTestId("raw-log");
    expect(raw).toHaveTextContent("/admin/export");
    expect(screen.getByText(/8 of 8 events revealed/)).toBeInTheDocument();
  });

  test("the case report is one click away", async () => {
    mount("");
    expect(await screen.findByRole("link", { name: /report/i })).toHaveAttribute("href", "/app/evidence/case_bf/report");
  });

  test("a Decision tab hosts the dry-run decision workflow", async () => {
    mount("");
    await userEvent.click(await screen.findByRole("tab", { name: "Decision" }));
    expect(await screen.findByText("DRY RUN — NO LIVE CONTAINMENT EXECUTED")).toBeInTheDocument();
    expect(screen.getByLabelText(/analyst id/i)).toBeInTheDocument();
  });
});
