/** Shared export helpers: source labelling, filenames, and the download trigger. */

export type DataSource = "mock" | "live";
export const MOCK_WATERMARK = "DEVELOPMENT FIXTURE / NOT REAL INVESTIGATION";
export const sourceLabel = (s: DataSource): string => (s === "mock" ? "Development fixture (mock): not a real investigation" : "Live API");

/** 20261119T101500Z: sortable, filesystem-safe, no colons. */
export const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Case ids and other log-derived text never reach a filename unfiltered. */
export const safeSegment = (s: string, max = 60): string => {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, max);
  return cleaned || "case";
};

export type ArtifactKind = "report" | "events" | "findings" | "decisions" | "graph";
export const ARTIFACT_EXT: Record<ArtifactKind, string> = { report: "pdf", events: "csv", findings: "csv", decisions: "csv", graph: "png" };
export const ARTIFACT_MIME: Record<ArtifactKind, string> = { report: "application/pdf", events: "text/csv;charset=utf-8", findings: "text/csv;charset=utf-8", decisions: "text/csv;charset=utf-8", graph: "image/png" };

/** Mock artifacts are unmistakable from the filename alone. */
export function exportFilename(o: { caseId: string; kind: ArtifactKind; source: DataSource; at: Date }): string {
  const prefix = o.source === "mock" ? "DEVFIXTURE_" : "";
  return `${prefix}soc-sentinel_${safeSegment(o.caseId)}_${stamp(o.at)}_${o.kind}.${ARTIFACT_EXT[o.kind]}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
