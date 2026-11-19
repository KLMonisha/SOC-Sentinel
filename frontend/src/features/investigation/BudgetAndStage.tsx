import type { Budget } from "./model";

/** Three-segment (or however many the backend reports) budget. Reflects only backend-reported state. */
export function BudgetMeter({ budget, executing }: { budget: Budget; executing: boolean }) {
  const segs = Array.from({ length: budget.total }, (_, i) => {
    if (i < budget.used) return "used";
    if (executing && i === budget.used) return "executing"; // the query in flight: shown, not yet charged
    return budget.exhausted ? "exhausted" : "available";
  });
  const status = budget.exhausted
    ? "Budget exhausted"
    : executing
      ? "Query in flight"
      : "Ready";
  return (
    <section aria-labelledby="inv-budget-h" data-testid="budget">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="inv-budget-h" className="t-micro text-ink">Query budget</h2>
        <span className={`t-label ${budget.exhausted ? "!text-critical" : ""}`} role="status">{status}</span>
      </div>
      <ol className="mt-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(budget.total, 1)}, minmax(0, 1fr))` }} aria-label={`${budget.used} of ${budget.total} queries used, ${budget.remaining} remaining`}>
        {segs.map((s, i) => (
          <li key={i} className="inv-seg" data-state={s} data-testid="budget-segment" aria-label={`Query ${i + 1}: ${s === "exhausted" ? "unavailable, budget exhausted" : s}`} />
        ))}
      </ol>
      <dl className="mt-4 flex gap-8">
        <div><dt className="t-label">Used</dt><dd className="t-display mt-1 text-[22px] tabular-nums" data-testid="budget-used">{budget.used}</dd></div>
        <div><dt className="t-label">Remaining</dt><dd className={`t-display mt-1 text-[22px] tabular-nums ${budget.exhausted ? "text-critical" : "text-verified"}`} data-testid="budget-remaining">{budget.remaining}</dd></div>
        <div><dt className="t-label">Total</dt><dd className="t-display mt-1 text-[22px] tabular-nums text-ink-muted">{budget.total}</dd></div>
      </dl>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
        Each executed query costs one. The count changes only when the backend reports it.
      </p>
    </section>
  );
}

export type StageName = "proposed" | "executing" | "retrieved" | "assessed";
const STAGES: { id: StageName; label: string }[] = [
  { id: "proposed", label: "Proposed" },
  { id: "executing", label: "Executing" },
  { id: "retrieved", label: "Retrieved" },
  { id: "assessed", label: "Assessed" },
];

/** PROPOSED → EXECUTING → RETRIEVED → ASSESSED. `stage` null = nothing proposed yet. */
export function StageRail({ stage, failed }: { stage: StageName | null; failed: boolean }) {
  const at = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  const fill = at <= 0 ? 0 : at / (STAGES.length - 1);
  return (
    <>
    <ol className="inv-track" style={{ ["--fill" as string]: fill }} aria-label="Investigation stages" data-testid="stage-rail" data-stage={stage ?? "none"}>
      {STAGES.map((s, i) => {
        const state = failed && i === at ? "failed" : i < at ? "done" : i === at ? (s.id === "assessed" ? "done" : "active") : "todo";
        return (
          <li key={s.id} className="inv-node" data-state={state} aria-current={i === at ? "step" : undefined}>
            <span className="inv-dot" aria-hidden />
            <span className={`t-micro max-sm:sr-only ${i <= at ? "text-ink" : "text-ink-faint"}`}>{s.label}</span>
            {state === "failed" && <span className="sr-only">failed</span>}
          </li>
        );
      })}
    </ol>
    <p className="t-micro mt-3 text-center text-ink sm:hidden" aria-hidden>{stage ? STAGES[at]!.label : "Select a query"}</p>
    </>
  );
}
