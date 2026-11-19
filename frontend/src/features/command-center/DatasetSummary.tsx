import type { UploadResponse } from "@/api/types";
import { Surface } from "@/components/ui/Surface";

function Stat({ label, value, tone = "ink" }: { label: string; value: number | string; tone?: "ink" | "amber" }) {
  return (
    <div>
      <dt className="t-label">{label}</dt>
      <dd className={`t-display mt-2 text-[30px] tabular-nums ${tone === "amber" ? "text-suspicious" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

/** Result of the last upload in this session. The backend does not expose past ingestion summaries. */
export function DatasetSummary({ upload }: { upload: UploadResponse }) {
  const { counts, validation_errors: errors } = upload;
  return (
    <Surface level="raised" brackets className="px-6 py-6" aria-label="Dataset ingested">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="t-micro text-ink">Dataset ingested</h2>
        <span className="font-mono text-[11.5px] text-ink-faint" title="SHA-256 of the uploaded file">
          {upload.filename} · {upload.dataset_id} · sha256 {upload.file_sha256.slice(0, 12)}…
        </span>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Records read" value={counts.total_records} />
        <Stat label="Events processed" value={counts.valid_events} />
        <Stat label="Quarantined" value={counts.quarantined_records} tone={counts.quarantined_records > 0 ? "amber" : "ink"} />
        <Stat label="Cases created" value={upload.cases.length} />
      </dl>
      {errors.length > 0 && (
        <div className="mt-6">
          <h3 className="t-label text-suspicious">Quarantined rows</h3>
          <ul className="mat-plane mt-2 max-h-40 divide-y divide-line overflow-auto font-mono text-xs">
            {errors.map((e) => (
              <li key={`${e.row_number}-${e.reason}`} className="flex gap-4 px-4 py-2">
                <span className="w-16 shrink-0 text-ink-faint">row {e.row_number}</span>
                <span className="text-ink-muted">{e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Surface>
  );
}
