import type { ReactNode } from "react";

/** A key numeral set in the display face, with a quiet label. */
export function Readout({ label, value, unit, hint, tone = "ink", size = "lg" }: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: "ink" | "mint" | "amber" | "red" | "muted";
  size?: "md" | "lg" | "xl";
}) {
  const color = { ink: "text-ink", mint: "text-verified", amber: "text-suspicious", red: "text-critical", muted: "text-ink-muted" }[tone];
  const sz = { md: "text-[26px]", lg: "text-[38px]", xl: "text-[56px]" }[size];
  return (
    <div>
      <div className="t-label">{label}</div>
      <div className={`t-display mt-2 tabular-nums ${sz} ${color}`}>
        {value}
        {unit && <span className="ml-1.5 text-[0.38em] tracking-[0.12em] text-ink-faint">{unit}</span>}
      </div>
      {hint && <div className="mt-2 text-[12.5px] text-ink-muted">{hint}</div>}
    </div>
  );
}
