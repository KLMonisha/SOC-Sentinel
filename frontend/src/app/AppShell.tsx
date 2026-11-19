import { AnimatePresence, motion } from "motion/react";
import { useLocation, useOutlet } from "react-router-dom";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { ContextBar } from "./ContextBar";
import { Rail } from "./Rail";
import { useTransition } from "./transition/TransitionProvider";

/** Persistent shell: rail, context bar and a stage whose content cross-fades between sections. */
export function AppShell() {
  const { stage } = useTransition();
  const outlet = useOutlet();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  const section = pathname.split("/")[2] ?? "";

  return (
    <div className="app-env">
      <Rail visible={stage >= 1} />
      <div className="relative z-[2] flex h-full flex-col pl-[var(--rail-w)]">
        <ContextBar visible={stage >= 1} />
        <main className="page-stage min-h-0 flex-1 overflow-auto">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: reduced ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="min-h-full"
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
