import type { ReactNode } from "react";

export function Panel({ title, meta, children, className = "" }: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-line bg-surface ${className}`}>
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{title}</h2>
        {meta && <div className="font-mono text-[11px] text-ink-faint">{meta}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
