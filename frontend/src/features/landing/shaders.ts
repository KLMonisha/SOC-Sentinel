/**
 * GLSL for the Evidence Singularity. The silk-fold displacement is a sum of domain-warped sines so the
 * very same function exists in TypeScript (`fold`) for anchoring labels exactly on the deforming surface.
 * Masks (veins, dissolve) use simplex noise on the GPU only.
 */

export function fold(p: [number, number, number], uvY: number, t: number): number {
  const [x, y, z] = p;
  const wx = x + 0.55 * Math.sin(y * 0.9 + t * 0.07);
  const wy = y + 0.55 * Math.sin(z * 0.8 + 1.3 - t * 0.06);
  const wz = z + 0.55 * Math.sin(x * 0.7 + 2.1 + t * 0.05);
  const s1 = Math.sin(1.25 * wx + 1.6 * Math.sin(0.9 * wy + t * 0.05)) * Math.cos(1.05 * wz + 1.4 * Math.sin(0.8 * wx + 0.7));
  const s2 = Math.sin(2.3 * wy + 1.2 * Math.sin(1.7 * wz + 0.4)) * Math.sin(2.1 * wx + 0.9);
  const s3 = Math.sin(4.1 * wz + 2.0 * Math.sin(3.3 * wx + t * 0.1));
  const edge = Math.pow(Math.abs(uvY - 0.5) * 2, 2);
  return 0.5 * s1 + 0.16 * s2 + edge * 0.16 * s3;
}

const COMMON = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uDissolve;
uniform float uIntro;
uniform vec3 uPointer;
uniform float uPointerAmp;
uniform vec3 uClick;
uniform vec2 uRipple; // x: radius, y: amplitude

float fold(vec3 p, vec2 uv, float t) {
  vec3 w = p + 0.55 * vec3(sin(p.y * 0.9 + t * 0.07), sin(p.z * 0.8 + 1.3 - t * 0.06), sin(p.x * 0.7 + 2.1 + t * 0.05));
  float s1 = sin(1.25 * w.x + 1.6 * sin(0.9 * w.y + t * 0.05)) * cos(1.05 * w.z + 1.4 * sin(0.8 * w.x + 0.7));
  float s2 = sin(2.3 * w.y + 1.2 * sin(1.7 * w.z + 0.4)) * sin(2.1 * w.x + 0.9);
  float s3 = sin(4.1 * w.z + 2.0 * sin(3.3 * w.x + t * 0.1));
  float edge = pow(abs(uv.y - 0.5) * 2.0, 2.0);
  return 0.5 * s1 + 0.16 * s2 + edge * 0.16 * s3;
}

float field(vec3 p, vec2 uv) {
  float d = uAmp * fold(p, uv, uTime);
  vec3 q = p - uPointer;
  d += uPointerAmp * 0.34 * exp(-dot(q, q) * 1.1);
  float r = length(p - uClick);
  d += uRipple.y * 0.3 * exp(-pow(r - uRipple.x, 2.0) * 5.0);
  return d;
}

// Ashima / Ian McEwan 3D simplex noise
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Shared by the surface and the released signals so they dissolve in the same places.
float dissolveValue(vec3 base, vec2 uv) {
  return 0.6 * (0.5 + 0.5 * snoise(base * 0.9 + 3.0)) + 0.4 * uv.x;
}
`;

export const SURFACE_VERT = /* glsl */ `
${COMMON}
attribute vec3 aTu;
attribute vec3 aTv;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vBase;
varying float vD;

void main() {
  vec3 n0 = normalize(cross(aTu, aTv));
  float eu = 0.004;
  float ev = 0.02;
  float d0 = field(position, uv);
  float dU = field(position + aTu * eu, uv + vec2(eu, 0.0));
  float dV = field(position + aTv * ev, uv + vec2(0.0, ev));
  vec3 tU = aTu + n0 * (dU - d0) / eu;
  vec3 tV = aTv + n0 * (dV - d0) / ev;
  vec3 n = normalize(cross(tU, tV));
  vec3 pos = position + n0 * d0;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  vBase = position;
  vD = d0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const SURFACE_FRAG = /* glsl */ `
${COMMON}
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vBase;
varying float vD;

float strip(vec3 d, vec3 c, vec3 a, float hl, float hw, float soft) {
  c = normalize(c);
  vec3 b = normalize(cross(c, a));
  vec3 a2 = cross(b, c);
  float z = dot(d, c);
  if (z <= 0.0) return 0.0;
  float x = dot(d, a2) / z;
  float y = dot(d, b) / z;
  return smoothstep(hl + soft, hl, abs(x)) * smoothstep(hw + soft, hw, abs(y));
}

// A dark studio: long cool strip lights, one mint rim light. No amber light: amber only ever marks uncertainty.
vec3 studio(vec3 d) {
  float up = d.y * 0.5 + 0.5;
  vec3 col = mix(vec3(0.006, 0.014, 0.013), vec3(0.06, 0.09, 0.085), smoothstep(0.05, 1.0, up));
  col += vec3(0.26, 0.31, 0.3) * smoothstep(0.15, 0.95, dot(d, normalize(vec3(-0.3, 0.4, 0.85))));
  col += vec3(3.0, 3.05, 3.0) * strip(d, vec3(-0.6, 0.5, 0.62), vec3(0.0, 1.0, 0.25), 1.1, 0.24, 0.26);
  col += vec3(2.0, 2.1, 2.1) * strip(d, vec3(0.1, 0.95, 0.22), vec3(1.0, 0.0, 0.0), 1.4, 0.16, 0.24);
  col += vec3(0.16, 1.0, 0.78) * 0.85 * strip(d, vec3(0.78, 0.2, -0.6), vec3(0.0, 1.0, 0.1), 0.9, 0.08, 0.16);
  col += vec3(0.8, 0.9, 0.9) * 0.9 * strip(d, vec3(-0.7, -0.25, -0.62), vec3(0.0, 1.0, 0.0), 0.9, 0.2, 0.25);
  col += vec3(0.5, 0.65, 0.62) * 0.6 * strip(d, vec3(0.2, -0.8, 0.5), vec3(1.0, 0.0, 0.0), 1.2, 0.18, 0.3);
  return col;
}

void main() {
  float dv = dissolveValue(vBase, vUv);
  float th = mix(-0.14, 1.14, uDissolve);
  float draw = mix(-0.1, 1.12, uIntro);
  if (dv < th) discard;
  if (vUv.x > draw) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N; // two-sided: a single continuous surface
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);

  // Slightly rough metal: average a few nearby reflection samples.
  vec3 refl = (studio(R) * 2.0 + studio(normalize(R + 0.14 * N.zxy)) + studio(normalize(R - 0.14 * N.yzx))) * 0.25;
  float fres = pow(1.0 - ndv, 3.0);

  // Thin-film shift kept in a narrow band so it travels silver -> mint -> graphite, never rainbow.
  float ph = ndv * 2.4 + vD * 1.6 + vBase.x * 0.1 + uTime * 0.01;
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (vec3(ph) + vec3(0.0, 0.1, 0.22)));
  vec3 tint = mix(vec3(0.8, 0.85, 0.84), vec3(0.34, 0.9, 0.78), film.g * 0.38);
  tint = mix(tint, vec3(0.1, 0.14, 0.14), smoothstep(0.55, 1.0, film.r) * 0.55);

  vec3 col = refl * tint * (0.8 + 1.2 * fres);
  col += vec3(0.004, 0.014, 0.012) * (1.0 - ndv);

  // Corroborated evidence: fine mint veins. Unresolved: rare amber pockets.
  float ridge = 1.0 - abs(snoise(vBase * 0.85 + vec3(0.0, uTime * 0.008, 0.0)));
  float vein = smoothstep(0.972, 0.995, ridge);
  col += vec3(0.25, 1.0, 0.82) * vein * (0.55 + 0.6 * fres);
  float pocket = smoothstep(0.8, 0.9, snoise(vBase * 0.7 + 11.0));
  col = mix(col, vec3(1.0, 0.62, 0.26) * (0.35 + refl.r * 0.5), pocket * 0.6);

  // Edge of the ribbon catches light and reads as a thin bevel.
  float eg = smoothstep(0.43, 0.5, abs(vUv.y - 0.5));
  col += vec3(0.7, 0.95, 0.9) * eg * 0.4 * (0.35 + fres);
  col *= 1.0 - eg * 0.22 * (1.0 - fres);

  // Dissolve and draw-in leading edges.
  float eDis = smoothstep(th + 0.07, th, dv) * step(0.0005, uDissolve);
  float eDraw = smoothstep(draw - 0.07, draw, vUv.x) * (1.0 - step(0.999, uIntro));
  col += vec3(0.25, 1.0, 0.82) * (eDis + eDraw) * 2.2;

  col *= mix(0.55, 1.0, smoothstep(-2.5, 1.2, vWorld.z));
  col = 1.0 - exp(-col * 1.25);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const SIGNAL_VERT = /* glsl */ `
${COMMON}
attribute vec3 aTu;
attribute vec3 aTv;
attribute vec4 aSeed;
uniform float uPixel;
varying float vAlpha;
varying vec3 vColor;

void main() {
  vec3 n0 = normalize(cross(aTu, aTv));
  float d0 = field(position, uv);
  vec3 pos = position + n0 * d0;

  float dv = dissolveValue(position, uv);
  float th = mix(-0.14, 1.14, uDissolve);
  float rel = clamp((th - dv) / 0.4, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - rel, 3.0);

  vec3 h = aSeed.xyz * 2.0 - 1.0;
  vec3 dir = normalize(n0 * 0.6 + h);
  float mag = 0.5 + 1.7 * aSeed.w;
  pos += dir * mag * e * 1.1;
  pos += 0.05 * e * vec3(sin(uTime * 0.4 + aSeed.x * 6.28), cos(uTime * 0.35 + aSeed.y * 6.28), sin(uTime * 0.3 + aSeed.z * 6.28));

  // Late in the scroll the released signals begin to gather into loose clusters.
  float g = smoothstep(0.75, 1.0, uDissolve) * e;
  int k = int(floor(aSeed.w * 2.999));
  vec3 centre = k == 0 ? vec3(-2.4, 0.8, 0.0) : (k == 1 ? vec3(0.2, -1.2, 0.5) : vec3(2.3, 1.1, -0.4));
  pos = mix(pos, centre + dir * (0.3 + mag * 0.45), g * 0.85);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.6 + 3.4 * aSeed.x) * uPixel * (7.0 / -mv.z);

  float c = fract(aSeed.x * 7.13 + aSeed.y * 3.7);
  vColor = c < 0.72 ? vec3(0.85, 0.9, 0.9) : (c < 0.95 ? vec3(0.3, 1.0, 0.82) : vec3(1.0, 0.66, 0.3));
  vAlpha = smoothstep(0.0, 0.12, rel) * (0.7 + 0.3 * aSeed.z);
}
`;

export const SIGNAL_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.08, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;
