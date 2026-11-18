import { useId, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { ApiError, api } from "@/api/client";
import type { UploadResponse } from "@/api/types";
import { Panel } from "@/components/ui/Panel";

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
    <Panel title="Log upload" meta="CSV · JSON · max 10 MB">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && !busy) void submit(f);
        }}
        className={`flex items-center justify-between gap-4 border border-dashed px-4 py-5 ${dragging ? "border-verified bg-surface-2" : "border-line-strong"}`}
      >
        <div className="text-[13px] text-ink-muted">
          Drop an authentication or web-server log here, or choose a file.
          <p className="mt-0.5 text-xs text-ink-faint">Malformed rows are quarantined and reported, not discarded silently.</p>
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
            className={`inline-flex cursor-pointer items-center gap-2 border border-line-strong bg-surface-2 px-3 py-2 text-[13px] hover:bg-surface-3 ${busy ? "pointer-events-none opacity-50" : ""}`}
          >
            <Upload size={14} aria-hidden /> Choose file
          </label>
        </div>
      </div>

      <div aria-live="polite" className="mt-3 min-h-5 text-[13px]">
        {phase.kind === "uploading" && (
          <p className="text-ink-muted">
            Uploading and analysing <span className="font-mono">{phase.name}</span>…
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
    </Panel>
  );
}
