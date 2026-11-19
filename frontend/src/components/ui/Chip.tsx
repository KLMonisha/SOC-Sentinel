import type { ReactNode } from "react";

export function Chip({ children, tone = "neutral", dot = false, dashed = false, title }: {
  children: ReactNode;
  tone?: "neutral" | "mint" | "amber" | "red";
  dot?: boolean;
  dashed?: boolean;
  title?: string;
}) {
  const c = {
    neutral: "text-ink-muted border-line-strong",
    mint: "text-verified border-verified/40",
    amber: "text-suspicious border-suspicious/45",
    red: "text-critical border-critical/50",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] ${dashed ? "border-dashed" : ""} ${c}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
