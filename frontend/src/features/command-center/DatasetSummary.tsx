import type { UploadResponse } from "@/api/types";
import { Panel } from "@/components/ui/Panel";

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-line px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg">{value}</dd>
    </div>
  );
}

export function DatasetSummary({ upload }: { upload: UploadResponse }) {
  const { counts, validation_errors: errors } = upload;
  return (
    <Panel title="Dataset" meta={<span title="SHA-256 of the uploaded file">{upload.filename} · sha256 {upload.file_sha256.slice(0, 12)}…</span>}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Records read" value={counts.total_records} />
        <Stat label="Events processed" value={counts.valid_events} />
        <Stat label="Quarantined" value={counts.quarantined_records} />
        <Stat label="Cases created" value={upload.cases.length} />
      </dl>
      {errors.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-[11px] uppercase tracking-wide text-suspicious">Quarantined rows</h3>
          <ul className="max-h-40 divide-y divide-line overflow-auto border border-line font-mono text-xs">
            {errors.map((e) => (
              <li key={`${e.row_number}-${e.reason}`} className="flex gap-3 px-3 py-1.5">
                <span className="w-16 shrink-0 text-ink-faint">row {e.row_number}</span>
                <span className="text-ink-muted">{e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
