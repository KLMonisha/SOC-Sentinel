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
}

export const createSceneState = (): SceneState => ({
  scroll: 0,
  pointer: { x: 0, y: 0 },
  intro: 0,
  rippleStart: -1,
  rippleAt: { x: 0, y: 0 },
  ready: false,
  calm: false,
});

/** Frame-rate independent exponential smoothing. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
