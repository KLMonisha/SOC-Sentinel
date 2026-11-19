/** Mutable state shared between the DOM layer and the render loop. Never triggers React renders. */
export interface SceneState {
  /** Scroll progress through the pinned hero journey, 0..1. */
  scroll: number;
  /** Pointer in NDC (-1..1). */
  pointer: { x: number; y: number };
  /** Entrance 0..1 (ribbon draws in along its length). */
  intro: number;
  /** Time (s) of the last click ripple, or -1. */
  rippleStart: number;
  /** Where the ripple started, in clip space. */
  rippleAt: { x: number; y: number };
  /** Set by the scene once it has drawn a frame. */
  ready: boolean;
  /** Reduced motion or the motion toggle is off: freeze idle flow, ignore pointer, no dissolve. */
  calm: boolean;
  /** Entering the app: 0 = landing as approved. 0..0.5 dissolve + compress, 0.5..1 reconstruct into `targets`. */
  leave: number;
  /** After the interface has taken over: fades the remaining signals and lines out (0..1). */
  handover: number;
  /** Screen-space targets for the reconstruct stage (NDC). Bumping `version` uploads them to the GPU. */
  targets: BridgeTargets | null;
  /** The landing stops reading scroll once it is leaving (the document is about to change height). */
  frozen: boolean;
  /** Smoothed frame time in ms, reported by the render loop (used to pick a transition mode). */
  frameMs: number;
}

export interface BridgeTargets {
  version: number;
  /** x, y (NDC), has: 3 floats per point. */
  points: Float32Array;
  /** Pairs of NDC endpoints: x1, y1, x2, y2 per segment. */
  lines: Float32Array;
}

export const createSceneState = (): SceneState => ({
  scroll: 0,
  pointer: { x: 0, y: 0 },
  intro: 0,
  rippleStart: -1,
  rippleAt: { x: 0, y: 0 },
  ready: false,
  calm: false,
  leave: 0,
  handover: 0,
  targets: null,
  frozen: false,
  frameMs: 16,
});

/** Frame-rate independent exponential smoothing. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
