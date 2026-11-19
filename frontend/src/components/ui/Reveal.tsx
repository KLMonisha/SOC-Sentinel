import { useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { useTransitionOptional } from "@/app/transition/TransitionProvider";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * Staged entrance used while the landing hands over to the application. When there is no transition
 * (deep link, refresh, back), `stage` is already 4 and nothing animates.
 */
export function Reveal({ at, children, className = "", delay = 0 }: { at: 1 | 2 | 3 | 4; children: ReactNode; className?: string; delay?: number }) {
  const stage = useTransitionOptional()?.stage ?? 4;
  const reduced = useReducedMotion();
  const shown = stage >= at;
  const startedShown = useRef(shown);
  return (
    <motion.div
      className={className}
      initial={startedShown.current ? false : { opacity: 0, y: 18 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
      transition={{ duration: reduced ? 0 : 0.75, delay: reduced ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
