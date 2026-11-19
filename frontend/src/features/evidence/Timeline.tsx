import { Pause, Play, RotateCcw, SkipBack, SkipForward, Rewind } from "lucide-react";
import { formatTime } from "@/lib/format";
import { useInvestigation } from "./InvestigationProvider";

const btn = "inline-flex h-9 items-center gap-1.5 border border-line-strong/70 px-3 text-[11px] uppercase tracking-[0.12em] text-ink-muted transition-colors hover:border-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-35";

/** Replay transport and chronological event list. Flat: hairlines and tone, no nested boxes. */
export function Timeline() {
  const { orderedEvents, state, dispatch, selectEvent } = useInvestigation();
  const { replay, total, playing } = state;
  const selected = state.selection?.id;

  return (
    <section aria-label="Incident timeline" className="px-5 pb-12 pt-8 sm:px-8 lg:px-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="t-micro text-ink">Incident timeline</h2>
        <p className="font-mono text-[11.5px] text-ink-faint" role="status">{replay} of {total} events revealed</p>
      </div>
      {total === 0 ? (
        <p className="mt-4 text-[13px] text-ink-muted">This case has no source events.</p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={() => dispatch({ type: "reset" })} aria-label="Reset replay to start">
              <RotateCcw size={13} aria-hidden /> Reset
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "step", delta: -1 })} disabled={replay === 0} aria-label="Step back">
              <SkipBack size={13} aria-hidden />
            </button>
            {playing ? (
              <button type="button" className={`${btn} !border-verified/60 !text-verified`} onClick={() => dispatch({ type: "pause" })}>
                <Pause size={13} aria-hidden /> Pause
              </button>
            ) : (
              <button type="button" className={`${btn} !border-verified/60 !text-verified`} onClick={() => dispatch({ type: "play" })}>
                <Play size={13} aria-hidden /> Play
              </button>
            )}
            <button type="button" className={btn} onClick={() => dispatch({ type: "step", delta: 1 })} disabled={replay === total} aria-label="Step forward">
              <SkipForward size={13} aria-hidden />
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "showAll" })} disabled={replay === total}>
              <Rewind size={13} aria-hidden className="rotate-180" /> Show full investigation
            </button>
          </div>
          <input
            type="range" min={0} max={total} value={replay} aria-label="Replay position"
            aria-valuetext={`${replay} of ${total} events`}
            onChange={(e) => dispatch({ type: "setReplay", value: Number(e.target.value) })}
            className="mt-5 block w-full accent-[#63ebd8]"
          />

          <ol className="mt-6 max-h-80 overflow-auto border-t border-line/70" aria-label="Events in chronological order">
            {orderedEvents.map((e, i) => {
              const revealed = i < replay;
              const current = replay < total && i === replay - 1;
              const isSel = selected === `event:${e.event_id}`;
              return (
                <li key={e.event_id} data-revealed={revealed} aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-4 border-b border-line/50 px-3 py-2 text-[12.5px] ${current ? "bg-verified/[0.07]" : ""} ${isSel ? "outline outline-1 -outline-offset-1 outline-focus" : ""}`}>
                  <span className="w-6 shrink-0 text-right font-mono text-[11px] text-ink-faint">{i + 1}</span>
                  {revealed ? (
                    <button type="button" onClick={() => selectEvent(e.event_id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 text-left hover:text-ink">
                      <span className="shrink-0 font-mono text-[11.5px] text-ink-muted">{formatTime(e.timestamp)}</span>
                      <span className="shrink-0 font-mono text-verified">{e.event_id}</span>
                      <span className="truncate text-ink-muted">{e.event_type} · {e.username ?? "—"} · {e.source_ip ?? "—"}</span>
                    </button>
                  ) : (
                    <span className="flex-1 text-ink-faint">Not yet revealed</span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
