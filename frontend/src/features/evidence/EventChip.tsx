import { AlertTriangle } from "lucide-react";
import { useInvestigation } from "./InvestigationProvider";

/** A citation to a source event. Resolves within the case or is shown as unresolved, never hidden. */
export function EventChip({ eventId }: { eventId: string }) {
  const { eventsById, selectEvent, state, visibleEventIds } = useInvestigation();
  if (!eventsById.has(eventId)) {
    return (
      <span title="This event ID does not resolve to a stored event in this case"
        className="inline-flex items-center gap-1 border border-critical/50 px-1.5 py-0.5 font-mono text-[11px] text-critical">
        <AlertTriangle size={10} aria-hidden /> {eventId} · unresolved
      </span>
    );
  }
  const revealed = visibleEventIds.has(eventId);
  return (
    <button
      type="button"
      onClick={() => selectEvent(eventId)}
      disabled={!revealed}
      title={revealed ? "Open source event" : "Not yet revealed in replay"}
      aria-label={`Event ${eventId}`}
      className={`border px-1.5 py-0.5 font-mono text-[11px] ${
        revealed ? "border-line-strong text-verified hover:bg-surface-3" : "cursor-not-allowed border-line text-ink-faint"
      } ${state.selection?.id === `event:${eventId}` ? "bg-surface-3" : ""}`}
    >
      {eventId}
    </button>
  );
}
