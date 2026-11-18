import { useRef } from "react";
import { motion } from "motion/react";
import { useTransitionOptional } from "@/app/transition/TransitionProvider";
import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * Screen title in the display face. Letters rise through a mask (as on the landing). `lines` may be a
 * second muted line. Accessible name is the plain text; the animated letters are hidden from assistive tech.
 */
export function DisplayTitle({ lines, at = 2, size = "text-[clamp(40px,6.2vw,92px)]", as: Tag = "h1" }: {
  lines: [string, string?];
  at?: 1 | 2 | 3 | 4;
  size?: string;
  as?: "h1" | "h2";
}) {
  const stage = useTransitionOptional()?.stage ?? 4;
  const reduced = useReducedMotion();
  const shown = stage >= at;
  const startedShown = useRef(shown);
  const label = lines.filter(Boolean).join(" ");
  let n = 0;
  return (
    <Tag aria-label={label} className={`t-display ${size}`}>
      {lines.map((line, li) =>
        line ? (
          <span key={li} aria-hidden className={`block ${li === 1 ? "text-ink-faint" : "text-ink"}`}>
            {[...line].map((ch, i) => {
              const d = (n++) * 0.045;
              return (
                <span key={i} className="inline-block overflow-hidden align-top" style={{ paddingBottom: "0.1em", marginBottom: "-0.1em" }}>
                  <motion.span
                    className="inline-block"
                    initial={startedShown.current ? false : { y: "115%" }}
                    animate={shown ? { y: "0%" } : { y: "115%" }}
                    transition={{ duration: reduced ? 0 : 1.1, delay: reduced ? 0 : d, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {ch === " " ? " " : ch}
                  </motion.span>
                </span>
              );
            })}
          </span>
        ) : null,
      )}
    </Tag>
  );
}
