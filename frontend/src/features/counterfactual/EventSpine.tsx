import { useRef, type KeyboardEvent } from "react";
import type { SourceEvent } from "@/api/types";

/**
 * The case's events in chronological order as a radio group. The selected event is "lifted" out of the chain:
 * it is the one that will be excluded from the branch. Arrow keys move the selection.
 */
export function EventSpine({ events, selected, onSelect, citedBy, disabled }: {
  events: SourceEvent[];
  selected: string | null;
  onSelect: (id: string) => void;
  citedBy: ReadonlyMap<string, number>;
  disabled?: boolean;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (i: number, d: number) => {
    const next = events[(i + d + events.length) % events.length];
    if (!next) return;
    onSelect(next.event_id);
    refs.current.get(next.event_id)?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); move(i, 1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); move(i, -1); }
  };

  return (
    <div role="radiogroup" aria-label="Event to exclude" className="relative max-h-[560px] overflow-auto py-1 pl-4 pr-1">
      <span aria-hidden className="absolute bottom-3 left-[22px] top-3 w-px bg-gradient-to-b from-transparent via-line-strong to-transparent" />
      {events.map((e, i) => {
        const on = selected === e.event_id;
        const n = citedBy.get(e.event_id) ?? 0;
        return (
          <button
            key={e.event_id}
            ref={(el) => { if (el) refs.current.set(e.event_id, el); else refs.current.delete(e.event_id); }}
            type="button" role="radio" aria-checked={on} disabled={disabled} data-event-id={e.event_id}
            tabIndex={on || (selected === null && i === 0) ? 0 : -1}
            onClick={() => onSelect(e.event_id)} onKeyDown={(ev) => onKey(ev, i)}
            className={`relative my-1 flex w-full items-center gap-3 px-3 py-2 text-left transition-all duration-500 [transition-timing-function:var(--ease-out)] disabled:opacity-60 ${
              on ? "mat-lit translate-x-3 shadow-[0_0_0_1px_rgba(99,235,216,0.55)]" : "hover:bg-surface-2"}`}
          >
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-verified shadow-[0_0_10px_#63ebd8]" : "bg-line-strong"}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-ink">{e.event_id}</span>
                <span className="font-mono text-[10.5px] text-ink-faint">{e.timestamp.slice(11, 19)}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
                {e.event_type} · {e.username ?? "—"} · {e.source_ip ?? "—"}
              </span>
            </span>
            {n > 0 && <span className="shrink-0 border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-muted" title={`${n} stored finding(s) cite this event`}>cited ×{n}</span>}
            {on && <span className="sr-only">selected to exclude</span>}
          </button>
        );
      })}
    </div>
  );
}
