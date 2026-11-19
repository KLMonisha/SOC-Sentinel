import { Eye, Lightbulb, CircleDashed } from "lucide-react";

export type EvidenceState = "observed" | "inferred" | "missing";

const STYLE = {
  observed: { cls: "text-verified border-verified/40", Icon: Eye, label: "Observed" },
  inferred: { cls: "text-suspicious border-suspicious/40", Icon: Lightbulb, label: "Inferred" },
  missing: { cls: "text-missing border-missing/50 border-dashed", Icon: CircleDashed, label: "Missing" },
} as const;

/** Distinguishes observed / inferred / missing by icon + label + border style, not colour alone. */
export function EvidenceBadge({ state }: { state: EvidenceState }) {
  const { cls, Icon, label } = STYLE[state];
  return (
    <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] ${cls}`}>
      <Icon size={11} aria-hidden /> {label}
    </span>
  );
}
