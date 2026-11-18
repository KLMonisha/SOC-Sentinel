import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/api/client";
import type { UploadResponse } from "@/api/types";
import { CaseQueue, type QueueState } from "@/features/command-center/CaseQueue";
import { DatasetSummary } from "@/features/command-center/DatasetSummary";
import { UploadPanel } from "@/features/command-center/UploadPanel";

export function CommandCenter() {
  const [queue, setQueue] = useState<QueueState>({ kind: "loading" });
  const [upload, setUpload] = useState<UploadResponse | null>(null);

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

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-lg font-semibold">Command Center</h1>
      <UploadPanel
        onUploaded={(r) => {
          setUpload(r);
          void load(); // the queue always reflects GET /api/cases, not client-side guesses
        }}
      />
      {upload && <DatasetSummary upload={upload} />}
      <CaseQueue state={queue} onRetry={() => void load()} />
    </div>
  );
}
