import { describe, expect, test } from "vitest";
import { initialState, investigationReducer as r, type InvState } from "./investigationState";

const run = (s: InvState, ...acts: Parameters<typeof r>[1][]) => acts.reduce(r, s);

describe("investigationReducer", () => {
  test("starts at the full investigation, nothing selected", () => {
    const s = initialState(5);
    expect(s.replay).toBe(5);
    expect(s.selection).toBeNull();
  });
  test("reset rewinds to zero events and stops playback", () => {
    const s = run(initialState(5), { type: "play" }, { type: "reset" });
    expect(s).toMatchObject({ replay: 0, playing: false });
  });
  test("step is clamped to [0, total]", () => {
    let s = run(initialState(3), { type: "reset" }, { type: "step", delta: -1 });
    expect(s.replay).toBe(0);
    s = run(s, { type: "step", delta: 1 }, { type: "step", delta: 1 }, { type: "step", delta: 1 }, { type: "step", delta: 1 });
    expect(s.replay).toBe(3);
  });
  test("play from the end restarts from zero; ticks advance one event and stop at the end", () => {
    let s = run(initialState(2), { type: "play" });
    expect(s).toMatchObject({ replay: 0, playing: true });
    s = r(s, { type: "tick" });
    expect(s).toMatchObject({ replay: 1, playing: true });
    s = r(s, { type: "tick" });
    expect(s).toMatchObject({ replay: 2, playing: false });
  });
  test("showAll returns to the full investigation", () => {
    expect(run(initialState(4), { type: "reset" }, { type: "showAll" }).replay).toBe(4);
  });
  test("play does nothing for an empty case", () => {
    expect(r(initialState(0), { type: "play" }).playing).toBe(false);
  });
  test("selecting switches to the inspector and is shared state", () => {
    const s = r(initialState(2), { type: "select", selection: { kind: "node", id: "event:e1" } });
    expect(s.selection).toEqual({ kind: "node", id: "event:e1" });
    expect(s.panel).toBe("inspector");
    expect(r(s, { type: "clear" }).selection).toBeNull();
  });
  test("scrubbing sets the position and pauses", () => {
    const s = run(initialState(5), { type: "reset" }, { type: "play" }, { type: "setReplay", value: 3 });
    expect(s).toMatchObject({ replay: 3, playing: false });
  });
});

describe("focus, follow and selection cause", () => {
  const sel = { kind: "node", id: "event:e1" } as const;
  test("focus requires a selection and is cleared with it", () => {
    expect(r(initialState(3), { type: "setFocus", focus: true }).focus).toBe(false);
    let s = run(initialState(3), { type: "select", selection: sel }, { type: "setFocus", focus: true });
    expect(s.focus).toBe(true);
    s = r(s, { type: "clear" });
    expect(s).toMatchObject({ focus: false, selection: null });
  });
  test("focus keeps the selection stable and does not touch replay", () => {
    const s = run(initialState(3), { type: "select", selection: sel }, { type: "setFocus", focus: true });
    expect(s.selection).toEqual(sel);
    expect(s.replay).toBe(3);
  });
  test("follow defaults on and toggles; selection records its cause", () => {
    expect(initialState(2).follow).toBe(true);
    expect(r(initialState(2), { type: "setFollow", follow: false }).follow).toBe(false);
    expect(r(initialState(2), { type: "select", selection: sel }).cause).toBe("user");
    expect(r(initialState(2), { type: "select", selection: sel, cause: "replay" }).cause).toBe("replay");
  });
});
