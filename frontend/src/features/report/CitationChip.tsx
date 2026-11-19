import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { evidencePath } from "./citations";

/**
 * A citation. Resolved: a link that opens the Evidence Room with that exact event selected.
 * Unresolved: an explicit warning, never a link and never silently dropped.
 */
export function CitationChip({ caseId, eventId, resolved }: { caseId: string; eventId: string; resolved: boolean }) {
  if (!resolved) {
    return (
      <span
        className="inline-flex items-center gap-1.5 border border-dashed border-suspicious/60 px-2 py-0.5 font-mono text-[11px] text-suspicious"
        title="This citation does not match any source event stored for this case."
      >
        <AlertTriangle size={11} aria-hidden /> {eventId} <span className="sr-only">(unresolved citation)</span>
        <span aria-hidden className="text-[10px] uppercase tracking-wider">unresolved</span>
      </span>
    );
  }
  return (
    <Link
      to={evidencePath(caseId, eventId)}
      className="inline-flex items-center border border-verified/40 px-2 py-0.5 font-mono text-[11px] text-verified transition-colors hover:bg-verified/10 focus-visible:bg-verified/10"
      title={`Open ${eventId} in the Evidence Room`}
    >
      {eventId}
    </Link>
  );
}
