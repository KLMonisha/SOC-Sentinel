import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/api/client";
import type { UploadResponse } from "@/api/types";
import { DisplayTitle } from "@/components/ui/DisplayTitle";
import { Readout } from "@/components/ui/Readout";
import { Reveal } from "@/components/ui/Reveal";
import { CaseField, FieldLegend } from "@/features/command-center/CaseField";
import { CaseQueue, type QueueState } from "@/features/command-center/CaseQueue";
import { DatasetSummary } from "@/features/command-center/DatasetSummary";
import { UploadPanel } from "@/features/command-center/UploadPanel";
import { NO_FILTERS, filterCases, type CaseFilters } from "@/features/command-center/filterCases";
import { deriveOverview } from "@/features/command-center/overview";
import { config } from "@/lib/config";

export function CommandCenter() {
  const [queue, setQueue] = useState<QueueState>({ kind: "loading" });
  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CaseFilters>(NO_FILTERS);

  const load = useCallback(async (signal?: AbortSignal) => {
    setQueue({ kind: "loading" });
    try {
      const res = await api.listCases(signal);
      setQueue({ kind: "ready", cases: res.cases });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setQueue({ kind: "error", error: e instanceof ApiError ? e : new Error("Unexpected error loading cases.") });
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const cases = useMemo(() => (queue.kind === "ready" ? queue.cases : []), [queue]);
  const o = useMemo(() => deriveOverview(cases), [cases]);
  const filtered = filters.query === "" && filters.severity === "all" && filters.status === "all";
  const matchIds = useMemo(() => (filtered ? undefined : new Set(filterCases(cases, filters).map((c) => c.case_id))), [cases, filters, filtered]);
  const known = queue.kind === "ready";
  const n = (v: number) => (known ? v : "—");

  return (
    <div className="mx-auto w-full max-w-[1760px] px-6 pb-20 pt-7 sm:px-10 lg:px-14">
      {/* The coordinator measures [data-bridge] elements and waits for [data-bridge-ready]. */}
      {queue.kind !== "loading" && <span data-bridge-ready hidden />}

      <header className="flex flex-wrap items-end justify-between gap-x-16 gap-y-8">
        <div data-bridge>
          <p className="t-label mb-4">Workspace · Investigations</p>
          <DisplayTitle lines={["Command", "Center"]} size="text-[clamp(26px,4.6vw,68px)]" />
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:items-end">
          <Reveal at={2} delay={0.5}>
            <p className="max-w-[56ch] text-[14.5px] leading-relaxed text-ink-muted lg:text-right">
              Every case here was built from logs you ingested. Open one to examine the evidence behind its verdict.
              {config.useMocks && (
                <span className="ml-3 inline-block border border-dashed border-line-strong px-2.5 py-1 align-middle font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                  Development fixtures · not backend data
                </span>
              )}
            </p>
          </Reveal>
          <Reveal at={3}>
            <dl data-bridge className="grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4 sm:gap-x-14">
              <Readout label="Cases" value={n(o.cases)} size="lg" />
              <Readout label="Open" value={n(o.open)} size="lg" hint={known ? `${o.unsettled} unsettled` : undefined} />
              <Readout label="High risk" value={n(o.highRisk)} size="lg" tone={known && o.highRisk > 0 ? "red" : "ink"} />
              <Readout label="Events" value={n(o.events)} size="lg" />
            </dl>
          </Reveal>
        </div>
      </header>

      <Reveal at={3} delay={0.1} className="mt-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div>
            <h2 className="t-micro text-ink">Case field</h2>
            <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-faint">
              Each mark is a case. Horizontal position is its time window; vertical position is its heuristic risk score (0–100, not a probability).
            </p>
          </div>
          <FieldLegend />
        </div>
        <div className="h-[clamp(340px,50vh,620px)]">
          <CaseField cases={cases} matchIds={matchIds} hoverId={hoverId} onHover={setHoverId} loading={queue.kind === "loading"} />
        </div>
      </Reveal>

      <Reveal at={4} className="mt-12 space-y-8">
        <div data-bridge>
          <UploadPanel
            onUploaded={(r) => {
              setUpload(r);
              void load(); // the queue always reflects GET /api/cases, not client-side guesses
            }}
          />
        </div>
        {upload && <DatasetSummary upload={upload} />}
        <div data-bridge>
          <CaseQueue state={queue} onRetry={() => void load()} filters={filters} onFilters={setFilters} hoverId={hoverId} onHover={setHoverId} />
        </div>
      </Reveal>
    </div>
  );
}
