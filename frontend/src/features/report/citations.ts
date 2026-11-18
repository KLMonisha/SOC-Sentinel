/** Citation helpers. A citation is only ever a real source event ID of the case; anything else is shown as unresolved. */
export interface Resolution {
  resolved: string[];
  unresolved: string[];
}

export function resolveCitations(ids: readonly string[], known: ReadonlySet<string>): Resolution {
  const seen = new Set<string>();
  const out: Resolution = { resolved: [], unresolved: [] };
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    (known.has(id) ? out.resolved : out.unresolved).push(id);
  }
  return out;
}

const enc = encodeURIComponent;
/** Deep link into the Evidence Room, optionally selecting an event (survives refresh and sharing). */
export const evidencePath = (caseId: string, eventId?: string): string =>
  `/app/evidence/${enc(caseId)}${eventId ? `?event=${enc(eventId)}` : ""}`;
export const reportPath = (caseId: string): string => `/app/evidence/${enc(caseId)}/report`;
