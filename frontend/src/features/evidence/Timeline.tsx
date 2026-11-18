import { Pause, Play, RotateCcw, SkipBack, SkipForward, Rewind } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { formatTime } from "@/lib/format";
import { useInvestigation } from "./InvestigationProvider";

const btn = "inline-flex items-center gap-1.5 border border-line-strong bg-surface-2 px-2.5 py-1 text-[12px] hover:bg-surface-3 disabled:opacity-40";

export function Timeline() {
  const { orderedEvents, state, dispatch, selectEvent } = useInvestigation();
  const { replay, total, playing } = state;
  const selected = state.selection?.id;

  return (
    <Panel title="Incident timeline" meta={`${replay} of ${total} events revealed`}>
      {total === 0 ? (
        <p className="text-[13px] text-ink-muted">This case has no source events.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={() => dispatch({ type: "reset" })} aria-label="Reset replay to start">
              <RotateCcw size={12} aria-hidden /> Reset
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "step", delta: -1 })} disabled={replay === 0} aria-label="Step back">
              <SkipBack size={12} aria-hidden />
            </button>
            {playing ? (
              <button type="button" className={btn} onClick={() => dispatch({ type: "pause" })}>
                <Pause size={12} aria-hidden /> Pause
              </button>
            ) : (
              <button type="button" className={btn} onClick={() => dispatch({ type: "play" })}>
                <Play size={12} aria-hidden /> Play
              </button>
            )}
            <button type="button" className={btn} onClick={() => dispatch({ type: "step", delta: 1 })} disabled={replay === total} aria-label="Step forward">
              <SkipForward size={12} aria-hidden />
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "showAll" })} disabled={replay === total}>
              <Rewind size={12} aria-hidden className="rotate-180" /> Show full investigation
            </button>
            <input
              type="range" min={0} max={total} value={replay} aria-label="Replay position"
              aria-valuetext={`${replay} of ${total} events`}
              onChange={(e) => dispatch({ type: "setReplay", value: Number(e.target.value) })}
              className="min-w-40 flex-1 accent-[#63ebd8]"
            />
          </div>

          <ol className="max-h-72 divide-y divide-line/60 overflow-auto border border-line" aria-label="Events in chronological order">
            {orderedEvents.map((e, i) => {
              const revealed = i < replay;
              const current = replay < total && i === replay - 1;
              const isSel = selected === `event:${e.event_id}`;
              return (
                <li key={e.event_id} data-revealed={revealed} aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-3 px-3 py-1.5 text-[12px] ${current ? "bg-surface-3" : ""} ${isSel ? "outline outline-1 -outline-offset-1 outline-focus" : ""}`}>
                  <span className="w-6 shrink-0 text-right font-mono text-[11px] text-ink-faint">{i + 1}</span>
                  {revealed ? (
                    <button type="button" onClick={() => selectEvent(e.event_id)} className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-ink">
                      <span className="shrink-0 font-mono text-[11px] text-ink-muted">{formatTime(e.timestamp)}</span>
                      <span className="shrink-0 font-mono text-verified">{e.event_id}</span>
                      <span className="truncate">{e.event_type} · {e.username ?? "—"} · {e.source_ip ?? "—"}</span>
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
    </Panel>
  );
}
