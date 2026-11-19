import type { BridgeTargets } from "@/features/landing/sceneState";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ndc = (x: number, y: number, w: number, h: number): [number, number] => [(x / w) * 2 - 1, -((y / h) * 2 - 1)];

/**
 * Turns the on-screen boxes of the real interface into the reconstruct stage's targets:
 * signal points distributed along each box outline (in proportion to its perimeter), plus line segments
 * for the outlines and the connections between neighbouring boxes. Pure and deterministic.
 */
export function buildBridgeTargets(boxes: readonly Box[], viewW: number, viewH: number, maxPoints = 3200, version = 1): BridgeTargets {
  const usable = boxes.filter((b) => b.width > 8 && b.height > 8 && b.x < viewW && b.y < viewH && b.x + b.width > 0 && b.y + b.height > 0);
  const perim = usable.map((b) => 2 * (b.width + b.height));
  const total = perim.reduce((a, b) => a + b, 0) || 1;
  const points: number[] = [];
  usable.forEach((b, bi) => {
    const n = Math.max(24, Math.round((perim[bi]! / total) * maxPoints));
    const p = perim[bi]!;
    for (let i = 0; i < n; i++) {
      const d = ((i + 0.5) / n) * p;
      let x: number;
      let y: number;
      if (d < b.width) { x = b.x + d; y = b.y; }
      else if (d < b.width + b.height) { x = b.x + b.width; y = b.y + (d - b.width); }
      else if (d < 2 * b.width + b.height) { x = b.x + b.width - (d - b.width - b.height); y = b.y + b.height; }
      else { x = b.x; y = b.y + b.height - (d - 2 * b.width - b.height); }
      const [nx, ny] = ndc(Math.min(Math.max(x, 0), viewW), Math.min(Math.max(y, 0), viewH), viewW, viewH);
      points.push(nx, ny, 1);
    }
  });

  const lines: number[] = [];
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const [a, b] = ndc(x1, y1, viewW, viewH);
    const [c, d] = ndc(x2, y2, viewW, viewH);
    lines.push(a, b, c, d);
  };
  for (const b of usable) {
    edge(b.x, b.y, b.x + b.width, b.y);
    edge(b.x + b.width, b.y, b.x + b.width, b.y + b.height);
    edge(b.x + b.width, b.y + b.height, b.x, b.y + b.height);
    edge(b.x, b.y + b.height, b.x, b.y);
  }
  // A restrained network: neighbouring panels (not the full-height rail or full-width bar) are joined by short
  // orthogonal links, like traces on a board, in reading order.
  const panels = usable
    .filter((b) => b.width < viewW * 0.9 && b.height < viewH * 0.7)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i + 1 < panels.length; i++) {
    const a = panels[i]!;
    const b = panels[i + 1]!;
    if (b.y >= a.y + a.height - 4) {
      const x1 = a.x + a.width / 2;
      const x2 = b.x + b.width / 2;
      const y1 = a.y + a.height;
      const ym = (y1 + b.y) / 2;
      edge(x1, y1, x1, ym);
      edge(x1, ym, x2, ym);
      edge(x2, ym, x2, b.y);
    } else {
      const ya = a.y + a.height / 2;
      const yb = b.y + b.height / 2;
      const xm = (a.x + a.width + b.x) / 2;
      edge(a.x + a.width, ya, xm, ya);
      edge(xm, ya, xm, yb);
      edge(xm, yb, b.x, yb);
    }
  }
  return { version, points: new Float32Array(points), lines: new Float32Array(lines) };
}
