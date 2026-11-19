/**
 * CSV export. Log fields are untrusted, so every text cell is neutralised against spreadsheet formula
 * injection: a value that begins with =, +, -, @, tab or carriage return gets a leading apostrophe, so
 * Excel / Sheets / LibreOffice show it as text instead of evaluating it. Every field is quoted. Numbers
 * (typed numbers only, never strings) are written as numbers. Output is deterministic: fixed columns and a
 * stable row order, with no timestamps added at export time.
 *
 * Missing values are kept, not dropped: the cell is empty and a `missing_fields` column lists which
 * fields were null/absent, so "empty" and "not recorded" stay distinguishable from the text "".
 */
import type { CaseDetail, DecisionRecord, Finding, SourceEvent } from "@/api/types";
import { orderEvents } from "@/features/evidence/model/graphModel";
import type { DataSource } from "./common";

export type Cell = string | number | boolean | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Text version of a value, with formula prefixes neutralised. Numbers are exempt (they are not untrusted text). */
export function neutralize(v: string): string {
  return FORMULA_PREFIX.test(v) ? `'${v}` : v;
}

export function csvCell(v: Cell): string {
  let text: string;
  if (v === null || v === undefined) text = "";
  else if (typeof v === "number" && Number.isFinite(v)) text = String(v);
  else if (typeof v === "boolean") text = v ? "true" : "false";
  else text = neutralize(String(v));
  return `"${text.replace(/"/g, '""')}"`;
}

const BOM = "﻿"; // lets Excel read UTF-8 correctly
export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [columns.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return BOM + lines.join("\r\n") + "\r\n";
}

const missing = (pairs: [string, unknown][]): string => pairs.filter(([, v]) => v === null || v === undefined || v === "").map(([k]) => k).join(";");
const where = (e: SourceEvent | undefined): string => (e ? `${e.source_file}:${e.line_number}` : "");

export const EVENT_COLUMNS = [
  "data_source", "case_id", "dataset_id", "sequence", "event_id", "timestamp_utc", "event_type", "username", "source_ip", "host",
  "resource", "outcome", "source_file", "line_number", "raw_sha256", "raw_text", "cited_by_findings", "missing_fields",
] as const;

export function eventsCsv(c: CaseDetail, source: DataSource): string {
  const cited = new Map<string, string[]>();
  for (const f of c.findings) for (const id of f.event_ids) cited.set(id, [...(cited.get(id) ?? []), f.finding_id]);
  const rows = orderEvents(c.events).map((e, i) => [
    source, c.summary.case_id, c.summary.dataset_id, i + 1, e.event_id, e.timestamp, e.event_type, e.username, e.source_ip, e.host,
    e.resource, e.outcome, e.source_file, e.line_number, e.raw_hash, e.raw_text, (cited.get(e.event_id) ?? []).sort().join(";"),
    missing([["username", e.username], ["source_ip", e.source_ip], ["host", e.host], ["resource", e.resource], ["source_file", e.source_file], ["raw_sha256", e.raw_hash], ["raw_text", e.raw_text]]),
  ]);
  return toCsv(EVENT_COLUMNS, rows);
}

export const FINDING_COLUMNS = [
  "data_source", "case_id", "finding_id", "rule_id", "title", "description", "severity", "stance", "weight",
  "event_ids", "unresolved_event_ids", "source_references", "missing_fields",
] as const;

export function findingsCsv(c: CaseDetail, source: DataSource): string {
  const byId = new Map(c.events.map((e) => [e.event_id, e]));
  const order = (f: Finding) => (f.stance === "supporting" ? 0 : 1);
  const sorted = [...c.findings].sort((a, b) => order(a) - order(b) || a.rule_id.localeCompare(b.rule_id) || a.finding_id.localeCompare(b.finding_id));
  const rows = sorted.map((f) => [
    source, c.summary.case_id, f.finding_id, f.rule_id, f.title, f.description, f.severity, f.stance, f.weight,
    f.event_ids.join(";"), f.event_ids.filter((id) => !byId.has(id)).join(";"),
    f.event_ids.filter((id) => byId.has(id)).map((id) => where(byId.get(id))).join(";"),
    missing([["event_ids", f.event_ids.length ? "x" : ""], ["description", f.description]]),
  ]);
  return toCsv(FINDING_COLUMNS, rows);
}

export const DECISION_COLUMNS = [
  "data_source", "case_id", "decision_id", "decision", "analyst_id", "decided_at_utc", "note", "dry_run", "missing_fields",
] as const;

export function decisionsCsv(c: CaseDetail, source: DataSource): string {
  const sorted = [...c.decisions].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.decision_id.localeCompare(b.decision_id));
  const rows = sorted.map((d: DecisionRecord) => [
    source, d.case_id, d.decision_id, d.decision, d.analyst_id, d.decided_at, d.note, d.dry_run,
    missing([["note", d.note], ["analyst_id", d.analyst_id]]),
  ]);
  return toCsv(DECISION_COLUMNS, rows);
}

export const csvBlob = (text: string): Blob => new Blob([text], { type: "text/csv;charset=utf-8" });
