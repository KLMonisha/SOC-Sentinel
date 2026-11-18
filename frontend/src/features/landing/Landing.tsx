import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import gsap from "gsap";
import Lenis from "lenis";
import { useTransitionOptional, type LandingController } from "@/app/transition/TransitionProvider";
import { useReducedMotion } from "@/lib/useReducedMotion";
import "./landing.css";
import { SingularityScene } from "./SingularityScene";
import { createSceneState } from "./sceneState";
import { hasWebGL } from "./webgl";

const MOTION_KEY = "soc-sentinel.landing.motion";
const readMotion = (): boolean => {
  try { return window.localStorage.getItem(MOTION_KEY) !== "off"; } catch { return true; }
};
const saveMotion = (on: boolean) => {
  try { window.localStorage.setItem(MOTION_KEY, on ? "on" : "off"); } catch { /* storage may be unavailable */ }
};

function Letters({ text }: { text: string }) {
  return (
    <>
      {[...text].map((ch, i) => (
        <span key={i} className="ln-mask"><span className="ln-letter">{ch}</span></span>
      ))}
    </>
  );
}

const Arrow = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M4 12L12 4M5 4h7v7" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const Mark = () => (
  <svg viewBox="0 0 26 26" fill="none" aria-hidden>
    <path d="M3 17c4-9 9-12 13-9s0 10-5 11-6-5-2-9 9-3 12 3" stroke="#63ebd8" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export default function Landing() {
  const navigate = useNavigate();
  const reducedPref = useReducedMotion();
  const [motion, setMotion] = useState(readMotion);
  const calm = reducedPref || !motion;
  const [webgl] = useState(hasWebGL);
  const [glFailed, setGlFailed] = useState(false);
  const useGl = webgl && !glFailed;
  const [pre, setPre] = useState(true);
  const [pressed, setPressed] = useState(false);
  const transition = useTransitionOptional();
  const [posterOk, setPosterOk] = useState(true);

  const state = useMemo(createSceneState, []);
  state.calm = calm;

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const introDone = useRef(false);

  // Scroll: smooth (Lenis) unless calm; the progress value feeds both the CSS variable and the scene.
  useEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;
    if (!root || !track) return;
    const update = () => {
      if (state.frozen) return; // leaving: the document is about to change height; keep the scene where it is
      const max = track.offsetHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      state.scroll = p;
      root.style.setProperty("--p", p.toFixed(4));
      root.dataset.hero = String(p < 0.14);
      root.dataset.end = String(p > 0.9);
    };
    let tick: ((t: number) => void) | null = null;
    if (!calm) {
      try {
        const lenis = new Lenis({ lerp: 0.1 });
        lenisRef.current = lenis;
        tick = (t) => lenis.raf(t * 1000);
        gsap.ticker.add(tick);
        gsap.ticker.lagSmoothing(0);
      } catch {
        // Smooth scrolling is an enhancement: fall back to native scrolling if it cannot start.
        lenisRef.current = null;
      }
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      if (tick) gsap.ticker.remove(tick);
      lenisRef.current?.destroy();
      lenisRef.current = null;
    };
  }, [calm, state]);

  // Pointer: drives the camera tilt and the surface swell; a press sends a ripple across the sculpture.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      state.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      state.pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    const down = (e: PointerEvent) => {
      if (state.calm || (e.target as HTMLElement).closest("a,button")) return;
      state.rippleAt = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -((e.clientY / window.innerHeight) * 2 - 1) };
      state.rippleStart = performance.now() / 1000;
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerdown", down); };
  }, [state]);

  // Entrance choreography: loader -> type resolves -> ribbon draws in -> interface arrives.
  useEffect(() => {
    const loader = loaderRef.current;
    const root = rootRef.current;
    if (!root) return;
    if (calm) {
      state.intro = 1;
      introDone.current = true;
      setPre(false);
      if (loader) loader.style.display = "none";
      return;
    }
    if (introDone.current) { state.intro = 1; return; }
    let cancelled = false;
    const ctx = gsap.context(() => {
      const load = { v: 0 };
      const loadTween = gsap.to(load, { v: 0.85, duration: 1.2, ease: "power1.out", onUpdate: () => loader?.style.setProperty("--load", String(load.v)) });
      const started = performance.now();
      const ready = async () => {
        await document.fonts?.ready;
        while (!cancelled && useGl && !state.ready) await new Promise((r) => setTimeout(r, 40));
        const wait = 1250 - (performance.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      };
      void ready().then(() => {
        if (cancelled) return;
        loadTween.kill();
        const tl = gsap.timeline({ defaults: { ease: "power3.out" }, onComplete: () => { introDone.current = true; setPre(false); } });
        tl.to(load, { v: 1, duration: 0.3, onUpdate: () => loader?.style.setProperty("--load", String(load.v)) })
          .to(loader, { autoAlpha: 0, duration: 0.7, ease: "power2.inOut" }, "+=0.1")
          .set(root.querySelectorAll(".ln-pre .ln-letter"), { opacity: 1 }, 0.6)
          .fromTo(root.querySelectorAll(".ln-back .ln-soc .ln-letter"), { yPercent: 115 }, { yPercent: 0, duration: 1.3, stagger: 0.09, ease: "expo.out" }, 0.75)
          .fromTo(root.querySelectorAll(".ln-back .ln-sen .ln-letter"), { yPercent: 115 }, { yPercent: 0, duration: 1.2, stagger: 0.06, ease: "expo.out" }, 1.05)
          .fromTo(root.querySelectorAll(".ln-front .ln-sen .ln-letter"), { yPercent: 115 }, { yPercent: 0, duration: 1.2, stagger: 0.06, ease: "expo.out" }, 1.05)
          .to(state, { intro: 1, duration: 3.0, ease: "power2.inOut" }, 0.55)
          .fromTo(root.querySelectorAll(".ln-fade"), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 1.0, stagger: 0.14 }, 2.1);
      });
    }, root);
    return () => { cancelled = true; ctx.revert(); };
  }, [calm, state, useGl]);

  // Lets the transition coordinator drive the scene while entering the app. Nothing here runs unless it does.
  const glRef = useRef(useGl);
  glRef.current = useGl;
  useEffect(() => {
    if (!transition) return;
    const root = () => rootRef.current;
    const ctrl: LandingController = {
      isReady: () => glRef.current && state.ready,
      frameMs: () => state.frameMs,
      begin: () => { state.frozen = true; lenisRef.current?.stop(); },
      setLeave: (v) => { state.leave = v; },
      setHandover: (v) => { state.handover = v; },
      setTargets: (t) => { state.targets = t; },
      setLook: (l) => {
        const r = root();
        if (!r) return;
        if (l === "none") delete r.dataset.leaving;
        else r.dataset.leaving = l;
      },
      reset: () => {
        state.frozen = false; state.leave = 0; state.handover = 0; state.targets = null;
        const r = root();
        if (r) delete r.dataset.leaving;
        setPressed(false);
        lenisRef.current?.start();
        window.dispatchEvent(new Event("scroll"));
      },
    };
    transition.registerLanding(ctrl);
    return () => transition.registerLanding(null);
  }, [transition, state]);

  useEffect(() => { document.title = "SOC Sentinel — What would change my mind?"; }, []);

  const enter = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setPressed(true); // immediate mint response
    if (transition) transition.enter("/app");
    else navigate("/app");
  }, [navigate, transition]);

  const explore = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const top = (track.offsetHeight - window.innerHeight) * 0.62;
    if (lenisRef.current) lenisRef.current.scrollTo(top, { duration: 2.2 });
    else window.scrollTo({ top, behavior: calm ? "auto" : "smooth" });
  }, [calm]);

  const toggleMotion = () => {
    const next = !motion;
    setMotion(next);
    saveMotion(next);
  };

  return (
    <div ref={rootRef} className="ln" data-calm={calm} data-hero="true" data-end="false" style={{ ["--p" as string]: 0 }}>
      <div ref={loaderRef} className="ln-loader" role="status" aria-label="Loading SOC Sentinel">
        <div className="ln-loader-word" data-text="SOC SENTINEL">SOC SENTINEL</div>
        <div className="ln-loader-note">ILLUSTRATIVE SCENE · NOT LIVE TELEMETRY</div>
      </div>

      <h1 className="ln-sr">SOC Sentinel. What would change my mind?</h1>

      <div ref={trackRef} className="ln-track">
        <div className={`ln-stage ${pre ? "ln-pre" : ""}`}>
          <div className="ln-haze" />

          <div className="ln-back" aria-hidden>
            <p className="ln-soc"><Letters text="SOC" /></p>
            <p className="ln-sen"><Letters text="SENTINEL" /></p>
          </div>

          <div className="ln-canvas" aria-hidden>
            {useGl ? (
              <SingularityScene state={state} paused={calm} onError={() => setGlFailed(true)} />
            ) : (
              posterOk && <img className="ln-poster" src="/landing-poster.webp" alt="" onError={() => setPosterOk(false)} />
            )}
          </div>

          <div className="ln-front" aria-hidden>
            <p className="ln-sen"><Letters text="SENTINEL" /></p>
          </div>

          <div className="ln-ui">
            <header className="ln-top">
              <Link to="/" className="ln-brand" aria-label="SOC Sentinel home"><Mark /> SOC SENTINEL</Link>
              <div className="ln-top-r ln-fade">
                <button type="button" className="ln-link" onClick={toggleMotion} aria-pressed={motion && !reducedPref} disabled={reducedPref}
                  title={reducedPref ? "Your system requests reduced motion" : "Turn motion on or off"}>
                  <span className="ln-dot" data-off={calm} aria-hidden />Motion {calm ? "off" : "on"}
                </button>
                <Link to="/app" className="ln-link ln-hide-s" onClick={enter}>Command Center</Link>
              </div>
            </header>

            <div className="ln-statement"><div className="ln-fade">
              <p className="ln-kicker">WHAT WOULD<br />CHANGE MY MIND<em>?</em></p>
              <p className="ln-copy">
                An investigator that argues against its own verdict. <b>Every claim is tied to a log line</b>,
                every gap is named, and the one piece of evidence that would flip the answer is shown.
              </p>
              <p className="ln-foot">ILLUSTRATIVE SCENE · NOT LIVE TELEMETRY</p>
            </div></div>

            <div className="ln-cta-wrap"><div className="ln-fade ln-cta-stack">
              <Link to="/app" className={`ln-cta ${pressed ? "is-pressed" : ""}`} onClick={enter}>
                <i /><i /><i /><i />
                Enter SOC Sentinel <Arrow />
              </Link>
              <button type="button" className="ln-link ln-sub" onClick={explore}>Explore the investigation ↓</button>
            </div></div>

            <div className="ln-cue" aria-hidden><span />SCROLL</div>

            <section className="ln-chapter" aria-label="Chapter 01">
              <small>01 / FROM NOISE TO EVIDENCE</small>
              <h2>Raw telemetry<br /><span>is not evidence yet.</span></h2>
              <p>Logs arrive as fragments. SOC Sentinel normalizes them, keeps the original line beside every field, and only then lets a finding claim them.</p>
              <p className="ln-foot">ILLUSTRATIVE ANIMATION</p>
            </section>

            <div className="ln-end" data-live="true">
              <Link to="/app" className="ln-cta" onClick={enter}><i /><i /><i /><i />Enter SOC Sentinel <Arrow /></Link>
            </div>
          </div>

          <div className="ln-vignette" />
          <div className="ln-grain" />
        </div>
      </div>
    </div>
  );
}
