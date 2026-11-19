import { useId, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { CaseDetail, DecisionRecord } from "@/api/types";
import { STATUS_LABEL } from "@/lib/format";
import { AuditHistory } from "./AuditHistory";

const ANALYST_KEY = "soc-sentinel.analyst-id";
const readAnalyst = () => {
  try { return window.localStorage.getItem(ANALYST_KEY) ?? ""; } catch { return ""; }
};
const saveAnalyst = (v: string) => {
  try { window.localStorage.setItem(ANALYST_KEY, v); } catch { /* storage may be unavailable */ }
};

export const DRY_RUN_BANNER = "DRY RUN — NO LIVE CONTAINMENT EXECUTED";

export function validateAnalystId(v: string): string | null {
  return v.trim() ? null : "Analyst ID is required.";
}

type Choice = "approve" | "reject";
type Submit =
  | { kind: "idle" }
  | { kind: "confirm"; choice: Choice }
  | { kind: "submitting"; choice: Choice }
  | { kind: "done"; record: DecisionRecord }
  | { kind: "error"; message: string; requestId: string | null; field: boolean };

/**
 * Analyst decision on the containment recommendation. Every path states that containment is a dry run:
 * recording a decision never blocks, disables or isolates anything.
 */
export function DecisionPanel({ caseDetail, onDecided }: { caseDetail: CaseDetail; onDecided: () => void | Promise<void> }) {
  const [analyst, setAnalyst] = useState(readAnalyst);
  const [note, setNote] = useState("");
  const [analystError, setAnalystError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });
  const inFlight = useRef(false); // one request per decision, however fast the clicks
  const analystId = useId();
  const noteId = useId();
  const errId = useId();

  const c = caseDetail;
  const rec = c.containment;
  const past = c.decisions.length;
  const busy = submit.kind === "submitting";

  function begin(choice: Choice) {
    const problem = validateAnalystId(analyst);
    setAnalystError(problem);
    if (problem) {
      setSubmit({ kind: "idle" });
      return;
    }
    setSubmit({ kind: "confirm", choice });
  }

  async function confirm(choice: Choice) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmit({ kind: "submitting", choice });
    try {
      const res = await api.decide(c.summary.case_id, { decision: choice, analyst_id: analyst.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      saveAnalyst(analyst.trim());
      setNote("");
      setSubmit({ kind: "done", record: res.record });
      // The decision is already recorded; a failed refresh must not be reported as a failed decision.
      void Promise.resolve(onDecided()).catch(() => undefined);
    } catch (e) {
      const apiErr = e instanceof ApiError ? e : null;
      setSubmit({
        kind: "error",
        message: apiErr?.message ?? "The decision could not be recorded.",
        requestId: apiErr?.requestId ?? null,
        field: apiErr?.code === "invalid_request",
      });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="space-y-7">
      <section aria-labelledby={`${errId}-rec`}>
        <h3 id={`${errId}-rec`} className="t-micro text-ink">Containment recommendation</h3>
        <p role="note" className="mt-3 flex items-center gap-2.5 border border-dashed border-ink-muted/50 bg-surface-2 px-3.5 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.1em] text-ink">
          <ShieldCheck size={15} aria-hidden className="shrink-0 text-verified" /> {DRY_RUN_BANNER}
        </p>
        {rec ? (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[13.5px]">
            <dt className="t-label">Action</dt><dd className="text-ink">{rec.action}</dd>
            <dt className="t-label">Target</dt><dd className="font-mono text-[12.5px] text-ink">{rec.target}</dd>
            <dt className="t-label">Rationale</dt><dd className="text-ink-muted">{rec.rationale}</dd>
          </dl>
        ) : (
          <p className="mt-4 text-[13.5px] text-ink-muted">No containment action is recommended for this case, so there is nothing to approve or reject.</p>
        )}
      </section>

      <section aria-label="Record a decision">
        <h3 className="t-micro text-ink">Your decision</h3>
        {past > 0 && (
          <p className="mt-2 text-[12.5px] text-ink-muted">
            This case already has {past} recorded decision{past === 1 ? "" : "s"} (current status: {STATUS_LABEL[c.summary.status]}). A new decision is added to the audit history; the backend decides whether repeated decisions are accepted.
          </p>
        )}
        <form className="mt-4 space-y-4" onSubmit={(e) => e.preventDefault()} noValidate>
          <div>
            <label htmlFor={analystId} className="t-label">Analyst ID <span className="text-critical" aria-hidden>*</span></label>
            <input
              id={analystId} value={analyst} disabled={busy || !rec} required
              onChange={(e) => { setAnalyst(e.target.value); if (analystError) setAnalystError(null); if (submit.kind === "confirm") setSubmit({ kind: "idle" }); }}
              aria-invalid={analystError !== null || (submit.kind === "error" && submit.field)}
              aria-describedby={analystError ? `${analystId}-err` : undefined}
              autoComplete="off" placeholder="e.g. priyanka"
              className="mt-2 w-full border-b border-line-strong bg-transparent py-2 font-mono text-[14px] outline-none placeholder:text-ink-faint focus:border-verified disabled:opacity-50"
            />
            {analystError && <p id={`${analystId}-err`} role="alert" className="mt-1.5 text-[12.5px] text-critical">{analystError}</p>}
          </div>
          <div>
            <label htmlFor={noteId} className="t-label">Note <span className="normal-case tracking-normal text-ink-faint">(optional)</span></label>
            <textarea
              id={noteId} value={note} disabled={busy || !rec} rows={3} onChange={(e) => setNote(e.target.value)}
              placeholder="Why you are approving or rejecting"
              className="mt-2 w-full resize-y border border-line-strong bg-transparent px-3 py-2 text-[13.5px] outline-none placeholder:text-ink-faint focus:border-verified disabled:opacity-50"
            />
          </div>

          {submit.kind === "confirm" ? (
            <div role="alertdialog" aria-label="Confirm decision" className="mat-lit px-4 py-4">
              <p className="text-[13.5px] text-ink">
                Record <strong>{submit.choice === "approve" ? "APPROVAL" : "REJECTION"}</strong> of this recommendation as <span className="font-mono">{analyst.trim()}</span>?
              </p>
              <p className="mt-1 text-[12.5px] text-ink-muted">{DRY_RUN_BANNER}. This records a decision only.</p>
              <div className="mt-3 flex gap-3">
                <button type="button" autoFocus onClick={() => void confirm(submit.choice)} className="border border-verified bg-verified/15 px-5 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-verified hover:bg-verified/25">
                  Confirm {submit.choice}
                </button>
                <button type="button" onClick={() => setSubmit({ kind: "idle" })} className="px-4 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={!rec || busy} onClick={() => begin("approve")}
                className="border border-verified/60 px-5 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-verified transition-colors hover:bg-verified/10 disabled:cursor-not-allowed disabled:opacity-40">
                Approve (dry run)
              </button>
              <button type="button" disabled={!rec || busy} onClick={() => begin("reject")}
                className="border border-line-strong px-5 py-2.5 text-[11.5px] uppercase tracking-[0.16em] text-ink-muted transition-colors hover:border-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">
                Reject
              </button>
            </div>
          )}

          <div role="status" aria-live="polite" className="min-h-6 text-[13px]">
            {submit.kind === "submitting" && <p className="text-ink-muted">Recording decision…</p>}
            {submit.kind === "done" && (
              <p className="text-verified">
                Decision recorded: {submit.record.decision === "approve" ? "approved" : "rejected"} by <span className="font-mono">{submit.record.analyst_id}</span> ({submit.record.decision_id}). {DRY_RUN_BANNER}.
              </p>
            )}
          </div>
          {submit.kind === "error" && (
            <p role="alert" className="text-[13px] text-critical">
              {submit.message}
              {submit.requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {submit.requestId}</span>}
            </p>
          )}
        </form>
      </section>

      <section aria-label="Audit history">
        <h3 className="t-micro mb-3 text-ink">Audit history</h3>
        <AuditHistory decisions={c.decisions} />
      </section>
    </div>
  );
}
