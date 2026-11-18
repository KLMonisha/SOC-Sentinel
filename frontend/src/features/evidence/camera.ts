import type { Bounds } from "./model/layout";

/** Camera timing. Short and consistent; zero when the user prefers reduced motion. */
export const CAMERA_MS = 400;
export const cameraDuration = (reducedMotion: boolean, ms = CAMERA_MS): number => (reducedMotion ? 0 : ms);

export const FRAME_PADDING = 0.16;
export const MIN_ZOOM = 0.25;
export const MAX_FRAME_ZOOM = 1.1;

export interface View {
  x: number;
  y: number;
  zoom: number;
}
export interface Size {
  width: number;
  height: number;
}

/** True when `b` already sits comfortably inside the current viewport (so the camera need not move). */
export function isComfortablyVisible(b: Bounds, view: View, size: Size, margin = 24): boolean {
  if (size.width <= 0 || size.height <= 0 || view.zoom <= 0) return false;
  const left = -view.x / view.zoom + margin / view.zoom;
  const top = -view.y / view.zoom + margin / view.zoom;
  const right = (-view.x + size.width) / view.zoom - margin / view.zoom;
  const bottom = (-view.y + size.height) / view.zoom - margin / view.zoom;
  return b.x >= left && b.y >= top && b.x + b.width <= right && b.y + b.height <= bottom;
}

/**
 * Whether selecting something should move the camera. Never for a replay-driven selection while
 * follow is off; otherwise only when the focus area is not already comfortably in view (or is tiny).
 */
export function shouldMoveCamera(o: {
  cause: "user" | "replay";
  follow: boolean;
  force: boolean;
  visible: boolean;
  zoom: number;
}): boolean {
  if (o.cause === "replay" && !o.follow) return false;
  if (o.force) return true;
  return !o.visible || o.zoom < 0.4;
}
