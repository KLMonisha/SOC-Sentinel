import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import gsap from "gsap";
import type { BridgeTargets } from "@/features/landing/sceneState";
import { buildBridgeTargets } from "./bridge";

/**
 * Landing -> application transition coordinator.
 *
 * The landing stays mounted (as a fixed overlay) while the application mounts underneath it, so the
 * landing's own signals can reconstruct into the outlines of the real interface. Modes:
 *   full       dissolve -> compress -> navigate -> reconstruct onto measured UI -> staged reveal (about 2.4 s)
 *   crossfade  the landing fades out over the application (scene not ready, slow frames, or no WebGL)
 *   immediate  plain navigation (reduced motion)
 * Any pointer press or key during the transition skips to the end state.
 */
export type Phase = "idle" | "leaving" | "revealing";
export type Mode = "full" | "crossfade" | "immediate";

export interface LandingController {
  isReady(): boolean;
  frameMs(): number;
  /** Freeze scroll reading and mark the landing as leaving. */
  begin(): void;
  setLeave(v: number): void;
  setHandover(v: number): void;
  setTargets(t: BridgeTargets): void;
  /** Drives CSS: "leave" fades type and UI, "handover" fades the haze, "fade" fades everything. */
  setLook(look: "none" | "leave" | "handover" | "fade"): void;
  /** Return to the approved landing state (used when a transition is cancelled by back navigation). */
  reset(): void;
}

interface TransitionApi {
  phase: Phase;
  /** 0..4. Elements with `Reveal at={n}` appear once stage >= n. Always 4 when no transition is running. */
  stage: number;
  enter: (href: string) => void;
  registerLanding: (c: LandingController | null) => void;
}

const Ctx = createContext<TransitionApi | null>(null);

/** For components that can also run standalone (the landing page in isolation, tests). */
export function useTransitionOptional(): TransitionApi | null {
  return useContext(Ctx);
}

export function useTransition(): TransitionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTransition must be used inside <TransitionProvider>");
  return v;
}

const readNumber = (key: string, fallback: number) => {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch { return fallback; }
};
const readMode = (): Mode | "auto" => {
  try {
    const m = window.localStorage.getItem("soc-sentinel.transition-mode");
    return m === "full" || m === "crossfade" || m === "immediate" ? m : "auto";
  } catch { return "auto"; }
};
export const SLOW_FRAME_MS = 45;

export function chooseMode(o: { override: Mode | "auto"; reduced: boolean; ready: boolean; frameMs: number }): Mode {
  if (o.override !== "auto") return o.override;
  if (o.reduced) return "immediate";
  if (!o.ready || o.frameMs > SLOW_FRAME_MS) return "crossfade";
  return "full";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function TransitionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState(4);
  const landing = useRef<LandingController | null>(null);
  const run = useRef<{ cancel: () => void } | null>(null);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const registerLanding = useCallback((c: LandingController | null) => { landing.current = c; }, []);

  const finish = useCallback(() => {
    run.current = null;
    setStage(4);
    setPhase("idle");
  }, []);

  const enter = useCallback((href: string) => {
    if (run.current) return; // one transition at a time; one navigation per click
    const ctrl = landing.current;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mode = chooseMode({ override: readMode(), reduced, ready: ctrl?.isReady() ?? false, frameMs: ctrl?.frameMs() ?? 999 });
    if (mode === "immediate" || !ctrl) { navigate(href); return; }

    const K = readNumber("soc-sentinel.transition-scale", 1);
    let cancelled = false;
    let navigated = false;
    const tweens: gsap.core.Tween[] = [];
    const goOnce = () => { if (!navigated) { navigated = true; navigate(href); } };
    const tween = (vars: gsap.TweenVars) => new Promise<void>((resolve) => { tweens.push(gsap.to(proxy, { ...vars, onComplete: resolve })); });
    const proxy = { leave: 0, handover: 0 };

    const cleanup = () => { window.removeEventListener("pointerdown", skip, true); window.removeEventListener("keydown", skip, true); clearTimeout(watchdog); };
    const skip = () => {
      if (cancelled) return;
      cancelled = true;
      tweens.forEach((t) => t.kill());
      goOnce();
      ctrl.setLeave(1);
      ctrl.setHandover(1);
      cleanup();
      finish();
    };
    const watchdog = setTimeout(skip, 7000 * K);
    run.current = {
      cancel: () => {
        cancelled = true;
        tweens.forEach((t) => t.kill());
        cleanup();
        ctrl.reset();
        run.current = null;
        setStage(4);
        setPhase("idle");
      },
    };
    // Defer so the click that started the transition does not skip it.
    setTimeout(() => {
      window.addEventListener("pointerdown", skip, true);
      window.addEventListener("keydown", skip, true);
    }, 250);

    setPhase("leaving");
    setStage(mode === "crossfade" ? 4 : 0);
    ctrl.begin();

    void (async () => {
      if (mode === "crossfade") {
        ctrl.setLook("fade");
        goOnce();
        await sleep(520 * K);
        if (cancelled) return;
        cleanup();
        finish();
        return;
      }

      ctrl.setLook("leave");
      await tween({ leave: 0.5, duration: 0.75 * K, ease: "power2.inOut", onUpdate: () => ctrl.setLeave(proxy.leave) });
      if (cancelled) return;
      goOnce();

      // Wait for the application to mount and lay out, then measure the real interface.
      const started = performance.now();
      let boxes: { x: number; y: number; width: number; height: number }[] = [];
      while (performance.now() - started < 1100 * K && !cancelled) {
        await sleep(60);
        const els = [...document.querySelectorAll<HTMLElement>("[data-bridge]")];
        boxes = els.map((e) => e.getBoundingClientRect());
        if (els.length >= 3 && document.querySelector("[data-bridge-ready]")) break;
      }
      if (cancelled) return;
      ctrl.setTargets(buildBridgeTargets(boxes, window.innerWidth, window.innerHeight, 3200, 1));
      await tween({ leave: 1, duration: 0.8 * K, ease: "power2.inOut", onUpdate: () => ctrl.setLeave(proxy.leave) });
      if (cancelled) return;

      setPhase("revealing");
      ctrl.setLook("handover");
      // The outlines hand over to real surfaces while the stages step in; both finish together.
      const handover = tween({ handover: 1, duration: 0.8 * K, ease: "power1.out", onUpdate: () => ctrl.setHandover(proxy.handover) });
      for (const s of [1, 2, 3, 4]) {
        setStage(s);
        await sleep(150 * K);
        if (cancelled) return;
      }
      await handover;
      if (cancelled) return;
      cleanup();
      finish();
    })();
  }, [navigate, finish]);

  // Browser back/forward during a transition returns to the landing as it was; the transition is not replayed.
  useEffect(() => {
    if (pathname === "/" && run.current) run.current.cancel();
  }, [pathname]);
  // A fast back press can land before React renders the intermediate route, so also listen to history directly.
  useEffect(() => {
    const onPop = () => { if (run.current && window.location.pathname === "/") run.current.cancel(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const value = useMemo<TransitionApi>(() => ({ phase, stage, enter, registerLanding }), [phase, stage, enter, registerLanding]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
