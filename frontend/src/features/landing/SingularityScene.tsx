import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { buildRibbon } from "./ribbon";
import { damp, lerp, smoothstep, type SceneState } from "./sceneState";
import { LINE_FRAG, LINE_VERT, SIGNAL_FRAG, SIGNAL_VERT, SURFACE_FRAG, SURFACE_VERT } from "./shaders";

/** Deterministic PRNG so the signal field is identical on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function useGeometry() {
  return useMemo(() => {
    const r = buildRibbon(640, 72);
    const surface = new THREE.BufferGeometry();
    surface.setAttribute("position", new THREE.BufferAttribute(r.position, 3));
    surface.setAttribute("aTu", new THREE.BufferAttribute(r.tangentU, 3));
    surface.setAttribute("aTv", new THREE.BufferAttribute(r.tangentV, 3));
    surface.setAttribute("uv", new THREE.BufferAttribute(r.uv, 2));
    surface.setIndex(new THREE.BufferAttribute(r.index, 1));

    // Signals: a deterministic subset of the surface's own vertices, so they leave from where the ribbon dissolves.
    const vCount = r.segV + 1;
    const pick: number[] = [];
    for (let i = 0; i <= r.segU; i += 3) for (let j = 0; j <= r.segV; j += 3) pick.push(i * vCount + j);
    const n = pick.length;
    const pos = new Float32Array(n * 3);
    const tu = new Float32Array(n * 3);
    const tv = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const seed = new Float32Array(n * 4);
    const rnd = mulberry32(20260119);
    pick.forEach((k, idx) => {
      pos.set(r.position.subarray(k * 3, k * 3 + 3), idx * 3);
      tu.set(r.tangentU.subarray(k * 3, k * 3 + 3), idx * 3);
      tv.set(r.tangentV.subarray(k * 3, k * 3 + 3), idx * 3);
      uv.set(r.uv.subarray(k * 2, k * 2 + 2), idx * 2);
      seed.set([rnd(), rnd(), rnd(), rnd()], idx * 4);
    });
    const signals = new THREE.BufferGeometry();
    signals.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    signals.setAttribute("aTu", new THREE.BufferAttribute(tu, 3));
    signals.setAttribute("aTv", new THREE.BufferAttribute(tv, 3));
    signals.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    signals.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    signals.setAttribute("aTarget", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return { surface, signals };
  }, []);
}

function makeUniforms() {
  return {
    uTime: { value: 0 },
    uAmp: { value: 0 },
    uDissolve: { value: 0 },
    uIntro: { value: 0 },
    uPointer: { value: new THREE.Vector3(99, 99, 99) },
    uPointerAmp: { value: 0 },
    uClick: { value: new THREE.Vector3() },
    uRipple: { value: new THREE.Vector2(-9, 0) },
    uPixel: { value: 1 },
    uLeave: { value: 0 },
    uHandover: { value: 0 },
  };
}

function Singularity({ state, paused }: { state: SceneState; paused: boolean }) {
  const group = useRef<THREE.Group>(null);
  const geo = useGeometry();
  const uniforms = useMemo(makeUniforms, []);
  const { viewport, gl, invalidate } = useThree();
  const smooth = useRef({ px: 0, py: 0, amp: 0, dissolve: 0, scroll: 0, energy: 0, lastPx: 0, lastPy: 0 });
  const clock = useRef(0);

  const surfaceMat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG, uniforms, side: THREE.DoubleSide }),
    [uniforms],
  );
  const signalMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SIGNAL_VERT, fragmentShader: SIGNAL_FRAG, uniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    [uniforms],
  );

  // Connections drawn between reconstructed interface points while entering the app. Hidden otherwise.
  const lineGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  const lineMat = useMemo(
    () => new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: { uAlpha: { value: 0 } },
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }),
    [],
  );
  const lines = useRef<THREE.LineSegments>(null);
  const appliedTargets = useRef(0);

  useEffect(() => () => {
    geo.surface.dispose(); geo.signals.dispose(); surfaceMat.dispose(); signalMat.dispose(); lineGeo.dispose(); lineMat.dispose();
  }, [geo, surfaceMat, signalMat, lineGeo, lineMat]);
  useEffect(() => { uniforms.uPixel.value = gl.getPixelRatio(); }, [gl, uniforms]);

  const tmp = useMemo(() => new THREE.Vector3(), []);

  // Demand mode (reduced motion / motion off): draw a few settling frames, then stay still.
  useEffect(() => {
    if (!paused) return;
    const ids = [0, 120, 400, 900].map((ms) => window.setTimeout(invalidate, ms));
    return () => ids.forEach(window.clearTimeout);
  }, [paused, invalidate]);

  useFrame((_, rawDt) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.05);
    const s = smooth.current;
    const calm = state.calm;
    if (!calm) clock.current += dt;
    const t = clock.current;

    // Pointer smoothed with inertia; energy follows pointer speed so the swell only wakes when you move.
    const tx = calm ? 0 : state.pointer.x;
    const ty = calm ? 0 : state.pointer.y;
    s.px = damp(s.px, tx, 3.2, dt);
    s.py = damp(s.py, ty, 3.2, dt);
    const speed = Math.hypot(s.px - s.lastPx, s.py - s.lastPy) / Math.max(dt, 1e-3);
    s.lastPx = s.px; s.lastPy = s.py;
    s.energy = damp(s.energy, Math.min(1, speed * 0.6), 2.0, dt);
    s.scroll = damp(s.scroll, state.scroll, 6, dt);
    const p = s.scroll;
    state.frameMs = damp(state.frameMs, rawDt * 1000, 3, Math.min(rawDt, 0.25));
    // Entering the app drives the same dissolve the scroll does, then the reconstruct stage takes over.
    const dissolveT = Math.max(calm ? 0 : smoothstep(0.2, 0.86, p), smoothstep(0, 0.45, state.leave));
    s.dissolve = damp(s.dissolve, dissolveT, 7, dt);
    s.amp = damp(s.amp, 0.35 + 0.65 * smoothstep(0.0, 0.7, state.intro), 3, dt);

    // Composition: the sculpture is large and cropped by the frame; scroll carries it out of the headline.
    // Landscape: sized to the frame. Portrait: sized to the width so the sculpture bleeds off the edges instead of filling the screen.
    const portrait = viewport.width < viewport.height;
    const base = portrait ? (viewport.width * 1.3) / 5.6 : Math.min(1.25, Math.max(viewport.width / 7.4, 0.55));
    const e1 = smoothstep(0.0, 0.62, p);
    g.scale.setScalar(base * lerp(portrait ? 1 : 0.98, portrait ? 0.7 : 0.66, e1));
    g.position.set(
      lerp(portrait ? 0 : viewport.width * 0.14, portrait ? 0 : -viewport.width * 0.2, e1),
      lerp(portrait ? viewport.height * 0.2 : 0, portrait ? viewport.height * 0.12 : -viewport.height * 0.14, e1),
      lerp(0, -0.8, e1),
    );
    g.rotation.set(
      0.3 + s.py * -0.12 + p * 0.5 + (calm ? 0 : Math.sin(t * 0.07) * 0.05),
      -0.22 + s.px * 0.22 + p * 1.15 + (calm ? 0 : t * 0.018),
      -0.14 + s.px * -0.05 + (calm ? 0 : Math.sin(t * 0.05) * 0.04),
    );
    g.updateMatrixWorld();

    // Pointer position in the ribbon's local space (on the z=0 plane in front of the camera).
    tmp.set((s.px * viewport.width) / 2, (s.py * viewport.height) / 2, 0.4);
    g.worldToLocal(tmp);
    uniforms.uPointer.value.copy(tmp);
    uniforms.uPointerAmp.value = s.energy * 0.9 * (1 - s.dissolve);

    // Click ripple.
    if (state.rippleStart >= 0) {
      const k = (performance.now() / 1000 - state.rippleStart) / 2.2;
      if (k >= 1) state.rippleStart = -1;
      else {
        uniforms.uRipple.value.set(k * 6.5, (1 - k) * (1 - k));
        const c = new THREE.Vector3((state.rippleAt.x * viewport.width) / 2, (state.rippleAt.y * viewport.height) / 2, 0.4);
        g.worldToLocal(c);
        uniforms.uClick.value.copy(c);
      }
    } else uniforms.uRipple.value.set(-9, 0);

    // Upload reconstruct targets once per version.
    const tg = state.targets;
    if (tg && tg.version !== appliedTargets.current) {
      appliedTargets.current = tg.version;
      const attr = geo.signals.getAttribute("aTarget") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const n = arr.length / 3;
      const m = tg.points.length / 3;
      for (let i = 0; i < n; i++) {
        // Spread the interface points across all signals deterministically; surplus signals fade out.
        if (i < m) { arr[i * 3] = tg.points[i * 3]!; arr[i * 3 + 1] = tg.points[i * 3 + 1]!; arr[i * 3 + 2] = 1; }
        else { arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = 0; }
      }
      attr.needsUpdate = true;
      const seg = tg.lines.length / 4;
      const pos = new Float32Array(seg * 6);
      for (let i = 0; i < seg; i++) {
        pos[i * 6] = tg.lines[i * 4]!; pos[i * 6 + 1] = tg.lines[i * 4 + 1]!;
        pos[i * 6 + 3] = tg.lines[i * 4 + 2]!; pos[i * 6 + 4] = tg.lines[i * 4 + 3]!;
      }
      lineGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    }
    const la = smoothstep(0.72, 0.97, state.leave) * (1 - state.handover) * 0.55;
    lineMat.uniforms.uAlpha!.value = la;
    if (lines.current) lines.current.visible = la > 0.001;
    uniforms.uLeave.value = state.leave;
    uniforms.uHandover.value = state.handover;

    uniforms.uTime.value = t;
    uniforms.uAmp.value = s.amp;
    uniforms.uIntro.value = state.intro;
    uniforms.uDissolve.value = s.dissolve;
    if (!state.ready) state.ready = true;
  });

  return (
    <group ref={group}>
      <mesh geometry={geo.surface} material={surfaceMat} frustumCulled={false} />
      <points geometry={geo.signals} material={signalMat} frustumCulled={false} />
      <lineSegments ref={lines} geometry={lineGeo} material={lineMat} frustumCulled={false} visible={false} />
    </group>
  );
}

export function SingularityScene({ state, paused, onError }: { state: SceneState; paused: boolean; onError: () => void }) {
  return (
    <Canvas
      className="!absolute inset-0"
      dpr={[1, 1.75]}
      camera={{ fov: 32, position: [0, 0, 7.4], near: 0.1, far: 40 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      frameloop={paused ? "demand" : "always"}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        const c = gl.domElement;
        c.addEventListener("webglcontextlost", (e) => { e.preventDefault(); onError(); });
      }}
      onError={onError}
      aria-hidden
    >
      <Singularity state={state} paused={paused} />
    </Canvas>
  );
}
