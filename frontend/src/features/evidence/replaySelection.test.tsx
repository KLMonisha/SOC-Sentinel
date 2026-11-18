import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { bruteForceCase } from "@/api/mocks/fixtures";
import { InvestigationProvider, useInvestigation } from "./InvestigationProvider";
import { orderEvents } from "./model/graphModel";

const wrapper = ({ children }: { children: ReactNode }) => (
  <InvestigationProvider caseDetail={bruteForceCase}>{children}</InvestigationProvider>
);
const ordered = orderEvents(bruteForceCase.events);

describe("replay selection and focus", () => {
  test("stepping forward selects the newly revealed event with cause 'replay'", () => {
    const { result } = renderHook(() => useInvestigation(), { wrapper });
    act(() => result.current.dispatch({ type: "reset" }));
    act(() => result.current.dispatch({ type: "step", delta: 1 }));
    expect(result.current.state.selection).toEqual({ kind: "node", id: `event:${ordered[0]!.event_id}` });
    expect(result.current.state.cause).toBe("replay");
    expect(result.current.activeEventId).toBe(ordered[0]!.event_id);
    expect(result.current.visibleEventIds.size).toBe(1);
  });

  test("future events stay hidden and the full-investigation verdict is untouched", () => {
    const { result } = renderHook(() => useInvestigation(), { wrapper });
    act(() => result.current.dispatch({ type: "reset" }));
    act(() => result.current.dispatch({ type: "step", delta: 1 }));
    expect(result.current.graph.nodes.some((n) => n.eventId === ordered[1]!.event_id)).toBe(false);
    expect(result.current.caseDetail.summary.verdict).toBe(bruteForceCase.summary.verdict);
  });

  test("scrubbing backwards past the selection clears it and exits focus", () => {
    const { result } = renderHook(() => useInvestigation(), { wrapper });
    act(() => result.current.selectEvent(ordered[5]!.event_id));
    act(() => result.current.dispatch({ type: "setFocus", focus: true }));
    expect(result.current.state.focus).toBe(true);
    act(() => result.current.dispatch({ type: "setReplay", value: 2 }));
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.focus).toBe(false);
  });

  test("focus does not change the visible graph data, only emphasis", () => {
    const { result } = renderHook(() => useInvestigation(), { wrapper });
    act(() => result.current.selectEvent(ordered[0]!.event_id));
    const before = result.current.graph.nodes.map((n) => n.id);
    act(() => result.current.dispatch({ type: "setFocus", focus: true }));
    expect(result.current.graph.nodes.map((n) => n.id)).toEqual(before);
  });
});
