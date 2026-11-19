/** Single shared state for selection, replay and view. 2D, list and (future) 3D all read this. */

export type Selection = { kind: "node" | "edge"; id: string };
export type CenterView = "graph" | "list";
export type SidePanel = "inspector" | "analysis" | "decision" | "export";

export interface InvState {
  /** Total number of events in the case. */
  total: number;
  /** Number of chronologically-ordered events revealed. `total` means the full investigation. */
  replay: number;
  playing: boolean;
  selection: Selection | null;
  view: CenterView;
  panel: SidePanel;
  /** Focus Mode: visually isolate the selection's direct neighbourhood. Never changes data or verdicts. */
  focus: boolean;
  /** Camera follows evidence revealed by replay. Turned off by any manual pan/zoom. */
  follow: boolean;
  /** Who made the current selection: the analyst, or the replay stepping to a new event. */
  cause: "user" | "replay";
}

export type InvAction =
  | { type: "select"; selection: Selection; cause?: "user" | "replay" }
  | { type: "clear" }
  | { type: "setReplay"; value: number }
  | { type: "step"; delta: 1 | -1 }
  | { type: "tick" }
  | { type: "reset" }
  | { type: "showAll" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "setView"; view: CenterView }
  | { type: "setPanel"; panel: SidePanel }
  | { type: "setFocus"; focus: boolean }
  | { type: "setFollow"; follow: boolean };

export const initialState = (total: number): InvState => ({
  total, replay: total, playing: false, selection: null, view: "graph", panel: "analysis",
  focus: false, follow: true, cause: "user",
});

const clamp = (n: number, total: number) => Math.max(0, Math.min(total, Math.trunc(n)));

export function investigationReducer(s: InvState, a: InvAction): InvState {
  switch (a.type) {
    case "select":
      if (s.selection?.kind === a.selection.kind && s.selection.id === a.selection.id && s.panel === "inspector") return s;
      return { ...s, selection: a.selection, panel: "inspector", cause: a.cause ?? "user" };
    case "clear":
      return s.selection || s.focus ? { ...s, selection: null, focus: false } : s;
    case "setFocus":
      // Focus needs something to focus on.
      return a.focus === s.focus || (a.focus && !s.selection) ? s : { ...s, focus: a.focus };
    case "setFollow":
      return a.follow === s.follow ? s : { ...s, follow: a.follow };
    case "setReplay":
      return { ...s, replay: clamp(a.value, s.total), playing: false };
    case "step": {
      const replay = clamp(s.replay + a.delta, s.total);
      return { ...s, replay, playing: false };
    }
    case "tick": {
      const replay = clamp(s.replay + 1, s.total);
      return { ...s, replay, playing: replay < s.total };
    }
    case "reset":
      return { ...s, replay: 0, playing: false };
    case "showAll":
      return { ...s, replay: s.total, playing: false };
    case "play":
      if (s.total === 0) return s;
      return { ...s, replay: s.replay >= s.total ? 0 : s.replay, playing: true };
    case "pause":
      return s.playing ? { ...s, playing: false } : s;
    case "setView":
      return { ...s, view: a.view };
    case "setPanel":
      return { ...s, panel: a.panel };
  }
}
