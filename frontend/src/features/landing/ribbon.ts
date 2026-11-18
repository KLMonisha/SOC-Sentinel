/**
 * The Evidence Singularity's base surface: a wide silk-like ribbon that closes into a twisted loop
 * (one half-twist, so the surface is single-sided). Pure and deterministic. The GPU then folds it with
 * a displacement field; this file only provides the base positions and tangents.
 *
 * Quality over mathematical purity: the centreline is a low-order Fourier curve (not a circle),
 * the width swells and pinches strongly, and the twist is modulated, so the result reads as a draped
 * sculpture and not as a textbook Möbius strip.
 */
export interface RibbonGeometryData {
  segU: number;
  segV: number;
  position: Float32Array; // base position
  tangentU: Float32Array; // dP/du  (per unit u in [0,1])
  tangentV: Float32Array; // dP/dv  (per unit v in [0,1], i.e. the full width vector)
  uv: Float32Array;
  index: Uint32Array;
}

type V3 = [number, number, number];
const TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const rotate = (v: V3, axis: V3, ang: number): V3 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)));
};

/** Closed centreline. Low-order harmonics keep it closed and give a generous, asymmetric sweep. */
export function centreline(u: number): V3 {
  const a = u * TAU;
  return [
    1.95 * Math.cos(a) + 0.55 * Math.cos(2 * a + 0.7),
    1.2 * Math.sin(a) + 0.5 * Math.sin(3 * a + 0.3),
    1.25 * Math.sin(2 * a + 1.1) + 0.4 * Math.sin(3 * a),
  ];
}

/** Ribbon width: dramatic swells and pinches. Always positive. */
export function widthAt(u: number): number {
  const a = u * TAU;
  return 1.5 + 0.7 * Math.sin(2 * a + 0.4) + 0.32 * Math.sin(3 * a + 1.9);
}

/** Twist angle about the tangent. Net change over the loop is exactly pi (single-sided); the rest is modulation. */
export function twistAt(u: number): number {
  return Math.PI * u + 0.95 * Math.sin(2 * TAU * u + 0.3) + 0.35 * Math.sin(3 * TAU * u + 1.2);
}

export function buildRibbon(segU = 640, segV = 72): RibbonGeometryData {
  const N = segU;
  // Frames at i = 0..N+1 using rotation-minimising transport (double reflection), then close the holonomy.
  const C: V3[] = [];
  const T: V3[] = [];
  for (let i = 0; i <= N + 1; i++) C.push(centreline(i / N));
  for (let i = 0; i <= N + 1; i++) {
    const p = centreline((i + 0.5) / N);
    const q = centreline((i - 0.5) / N);
    T.push(norm(sub(p, q)));
  }
  const R: V3[] = [];
  R[0] = norm(cross(T[0]!, [0, 0, 1]));
  for (let i = 0; i < N + 1; i++) {
    const v1 = sub(C[i + 1]!, C[i]!);
    const c1 = dot(v1, v1);
    const rL = sub(R[i]!, mul(v1, (2 / c1) * dot(v1, R[i]!)));
    const tL = sub(T[i]!, mul(v1, (2 / c1) * dot(v1, T[i]!)));
    const v2 = sub(T[i + 1]!, tL);
    const c2 = dot(v2, v2);
    R[i + 1] = c2 < 1e-12 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL)));
  }
  // After a full loop the transported frame (index N) differs from the start by a rotation about T0.
  const rN = R[N]!;
  const r0 = R[0]!;
  const holonomy = Math.atan2(dot(cross(rN, r0), T[0]!), dot(rN, r0));

  const W: V3[] = []; // unit width direction at each frame index 0..N+1
  for (let i = 0; i <= N + 1; i++) {
    const u = i / N;
    const base = rotate(R[i]!, T[i]!, holonomy * u);
    W.push(rotate(base, T[i]!, twistAt(u)));
  }
  const width = (i: number) => widthAt(i / N);
  // Neighbour access across the seam: one loop later the width direction is negated (half twist).
  const wdir = (i: number): V3 => {
    if (i < 0) return mul(W[N + i]!, -1);
    if (i > N) return mul(W[i - N]!, -1);
    return W[i]!;
  };
  const cpt = (i: number): V3 => (i < 0 ? C[N + i]! : i > N ? C[i - N]! : C[i]!);
  const wid = (i: number) => (i < 0 ? width(N + i) : i > N ? width(i - N) : width(i));

  const vCount = segV + 1;
  const uCount = N + 1;
  const count = uCount * vCount;
  const position = new Float32Array(count * 3);
  const tangentU = new Float32Array(count * 3);
  const tangentV = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);

  const surf = (i: number, v: number): V3 => add(cpt(i), mul(wdir(i), (v - 0.5) * wid(i)));
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= segV; j++) {
      const v = j / segV;
      const k = i * vCount + j;
      const p = surf(i, v);
      const du = mul(sub(surf(i + 1, v), surf(i - 1, v)), N / 2);
      const dv = mul(wdir(i), wid(i));
      position.set(p, k * 3);
      tangentU.set(du, k * 3);
      tangentV.set(dv, k * 3);
      uv[k * 2] = i / N;
      uv[k * 2 + 1] = v;
    }
  }
  const index = new Uint32Array(N * segV * 6);
  let o = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * vCount + j;
      const b = a + vCount;
      index.set([a, b, a + 1, b, b + 1, a + 1], o);
      o += 6;
    }
  }
  return { segU: N, segV, position, tangentU, tangentV, uv, index };
}
