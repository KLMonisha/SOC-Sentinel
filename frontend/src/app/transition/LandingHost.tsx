import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { useTransition } from "./TransitionProvider";

// The cinematic landing (and its WebGL bundle) loads only when `/` is opened. A direct visit to /app never loads it.
const Landing = lazy(() => import("@/features/landing/Landing"));

const Fallback = () => <div role="status" aria-label="Loading" style={{ position: "fixed", inset: 0, background: "#030807" }} />;

/**
 * Renders the landing at `/`, and keeps it mounted as a fixed overlay while a transition runs so its
 * particles can reconstruct into the application underneath. Unmounts (disposing the WebGL scene) afterwards.
 */
export function LandingHost() {
  const { pathname } = useLocation();
  const { phase } = useTransition();
  const onLanding = pathname === "/";
  if (!onLanding && phase === "idle") return null;
  const overlay = !(onLanding && phase === "idle");
  return (
    <div className={overlay ? "ln-host ln-host--overlay" : "ln-host"} data-phase={phase}>
      <Suspense fallback={<Fallback />}>
        <Landing />
      </Suspense>
    </div>
  );
}
