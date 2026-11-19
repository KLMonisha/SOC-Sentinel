import { useId, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { UploadResponse } from "@/api/types";
import { Brackets } from "@/components/ui/Brackets";

/** Matches the backend's documented 10 MB limit. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext !== "csv" && ext !== "json") return "Unsupported file type. Upload a .csv or .json file.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "File exceeds the 10 MB limit.";
  return null;
}

type Phase = { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "error"; message: string; requestId: string | null };

/** The ingestion instrument: a slim drop surface that reacts to drag, and reports every outcome. */
export function UploadPanel({ onUploaded }: { onUploaded: (r: UploadResponse) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  async function submit(file: File) {
    const problem = validateFile(file);
    if (problem) {
      setPhase({ kind: "error", message: problem, requestId: null });
      return;
    }
    setPhase({ kind: "uploading", name: file.name });
    try {
      onUploaded(await api.upload(file));
      setPhase({ kind: "idle" });
    } catch (e) {
      const apiErr = e instanceof ApiError ? e : null;
      setPhase({
        kind: "error",
        message: apiErr?.message ?? "Upload failed unexpectedly.",
        requestId: apiErr?.requestId ?? null,
      });
    }
  }

  const busy = phase.kind === "uploading";

  return (
    <section aria-label="Log ingestion">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && !busy) void submit(f);
        }}
        className={`brk relative flex flex-wrap items-center justify-between gap-5 px-6 py-5 transition-all duration-500 ${dragging ? "mat-lit" : "mat-plane"}`}
        style={dragging ? { boxShadow: "0 0 0 1px rgba(99,235,216,0.6), 0 0 60px -10px rgba(99,235,216,0.35)" } : undefined}
      >
        <Brackets />
        <div className="flex min-w-0 items-center gap-5">
          <span className={`grid h-11 w-11 shrink-0 place-items-center border ${dragging ? "border-verified text-verified" : "border-line-strong text-ink-muted"}`}>
            <Upload size={18} strokeWidth={1.5} aria-hidden className={busy ? "animate-pulse" : ""} />
          </span>
          <div className="min-w-0">
            <div className="t-micro text-ink">{dragging ? "Release to analyse" : busy ? "Analysing" : "Ingest a log"}</div>
            <p className="mt-1.5 text-[13.5px] text-ink-muted">
              Drop an authentication or web-server log here, or choose a file. <span className="text-ink-faint">CSV · JSON · max 10 MB · malformed rows are quarantined and reported, not discarded silently.</span>
            </p>
          </div>
        </div>
        <div>
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            accept=".csv,.json"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void submit(f);
            }}
          />
          <label
            htmlFor={inputId}
            className={`inline-flex cursor-pointer items-center gap-2 border border-verified/50 bg-transparent px-5 py-3 text-[11.5px] uppercase tracking-[0.18em] text-verified transition-colors hover:bg-verified/10 focus-within:bg-verified/10 ${busy ? "pointer-events-none opacity-50" : ""}`}
          >
            Choose file
          </label>
        </div>
      </div>

      <div aria-live="polite" className="min-h-5 px-1 pt-3 text-[13px]">
        {phase.kind === "uploading" && (
          <p className="text-ink-muted">
            Uploading and analysing <span className="font-mono text-ink">{phase.name}</span>…
            <span className="ml-2 text-xs text-ink-faint">(progress is indeterminate: the server analyses before responding)</span>
          </p>
        )}
        {phase.kind === "error" && (
          <p role="alert" className="text-critical">
            {phase.message}
            {phase.requestId && <span className="ml-2 font-mono text-xs text-ink-faint">request {phase.requestId}</span>}
          </p>
        )}
      </div>
    </section>
  );
}
