import type { AdversarialScenarioId } from "@/api/types";
import { SCENARIO_IDS, SCENARIOS } from "./model";

const ROWS: { key: "surface" | "violation" | "deviation" | "defence"; label: string }[] = [
  { key: "surface", label: "Attacker-controlled surface" },
  { key: "violation", label: "Attempted trust-boundary violation" },
  { key: "deviation", label: "Intended deviation" },
  { key: "defence", label: "Expected defensive behaviour" },
];

/** Three attack-surface modules as a native radio group (arrow keys move between them). */
export function ScenarioSelector({ value, onChange, disabled }: { value: AdversarialScenarioId | null; onChange: (id: AdversarialScenarioId) => void; disabled: boolean }) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">Attack scenario</legend>
      <div className="grid gap-4 lg:grid-cols-3">
        {SCENARIO_IDS.map((id, i) => {
          const s = SCENARIOS[id];
          return (
            <label key={id} className="rt-module mat-plane rt-rise block px-6 py-6" style={{ ["--i" as string]: i }} data-testid="scenario" data-scenario={id}>
              <input type="radio" name="scenario" value={id} checked={value === id} onChange={() => onChange(id)} className="peer sr-only" />
              <span className="flex items-baseline justify-between gap-4">
                <span className="t-display text-[28px] leading-none text-ink-faint" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
                <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${value === id ? "text-verified" : "text-ink-faint"}`}>{value === id ? "● Selected" : "○ Select"}</span>
              </span>
              <span className="mt-4 block text-[18px] font-medium text-ink">{s.name}</span>
              <span className="mt-1 block font-mono text-[12px] text-verified">{id}</span>

              {/* attacker-controlled text and trusted instructions are never drawn as the same thing */}
              <span className="mt-5 block" aria-hidden>
                <span className="rt-trusted block px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-verified">Trusted · system instructions</span>
                <span className="rt-boundary block" />
                <span className="rt-hostile block px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-suspicious">Attacker-controlled · log field</span>
              </span>

              <span className="mt-5 block space-y-3.5">
                {ROWS.map((r) => (
                  <span key={r.key} className="block">
                    <span className="t-label block">{r.label}</span>
                    <span className="mt-1 block text-[13.5px] leading-relaxed text-ink-muted">{s[r.key]}</span>
                  </span>
                ))}
              </span>
              <span className="mt-5 block text-[11.5px] text-ink-faint">Descriptive text. Not a measurement; no result exists until a test is run.</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
