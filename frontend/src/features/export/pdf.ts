/**
 * Client-side forensic PDF. Real text (standard Helvetica/Courier, so it stays selectable and searchable),
 * A4, automatic pagination with repeated table headers, safe wrapping of long tokens, a running header and
 * footer with page numbers, and (for mock data) a diagonal watermark on every page. jsPDF is loaded on demand.
 *
 * All log-derived text is escaped before drawing: control characters and anything outside Latin-1 appear as
 * visible \xNN / \uNNNN sequences, so hidden or bidirectional-override characters cannot disguise content.
 */
import type { jsPDF } from "jspdf";
import { sourceLabel } from "./common";
import type { Block, ReportModel, Tone } from "./reportModel";

const W = 595.28;
const H = 841.89;
const ML = 48;
const MR = 48;
const TOP = 74;
const BOT = 62;
const CW = W - ML - MR;
/** Diagonal mock watermark. Tested so the whole line always fits inside the page when rotated. */
export const WATERMARK = { size: 21, angle: 37 } as const;

type RGB = [number, number, number];
const INK: RGB = [22, 28, 27];
const MUTED: RGB = [96, 108, 105];
const ACCENT: RGB = [14, 107, 95];
const RULE: RGB = [200, 208, 205];
const TONE: Record<Tone, RGB> = { ok: [14, 110, 80], warn: [158, 98, 18], bad: [172, 40, 52] };

/** Visible escapes for anything the standard fonts cannot draw faithfully. Newlines are preserved. */
export function pdfSafe(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n") out += "\n";
    else if (ch === "\r") continue;
    else if (ch === "\t") out += "  ";
    else if (cp === 0x2013 || cp === 0x2014) out += "-";
    else if (cp === 0x2018 || cp === 0x2019) out += "'";
    else if (cp === 0x201c || cp === 0x201d) out += '"';
    else if (cp === 0x2192) out += "->";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp > 0xff) out += cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/** Insert spaces into unbroken runs longer than `n` so the wrapper can always break them. */
export function breakLong(s: string, n: number): string {
  const re = new RegExp(`\\S{${n + 1},}`, "g");
  return s.replace(re, (run) => run.match(new RegExp(`.{1,${n}}`, "g"))!.join(" "));
}

export interface PdfResult {
  blob: Blob;
  bytes: Uint8Array;
  pages: number;
}

export async function renderReportPdf(model: ReportModel): Promise<PdfResult> {
  const { jsPDF: JsPDF } = await import("jspdf");
  const doc: jsPDF = new JsPDF({ unit: "pt", format: "a4", compress: false });
  doc.setProperties({ title: `SOC Sentinel ${model.title}: ${pdfSafe(model.caseId)}`, subject: `Case ${pdfSafe(model.caseId)}`, author: "SOC Sentinel", creator: "SOC Sentinel (browser)", keywords: model.source === "mock" ? "development fixture" : "live" });

  let y = TOP;
  const newPage = () => { doc.addPage(); y = TOP; };
  const ensure = (h: number) => { if (y + h > H - BOT) newPage(); };
  const font = (style: "normal" | "bold" | "italic", size: number, family: "helvetica" | "courier" = "helvetica", color: RGB = INK) => {
    doc.setFont(family, style); doc.setFontSize(size); doc.setTextColor(...color);
  };
    const wrap = (text: string, width: number, size: number, family: "helvetica" | "courier" = "helvetica", style: "normal" | "bold" | "italic" = "normal"): string[] => {
    font(style, size, family);
    // Break only tokens whose MEASURED width exceeds the column, so ordinary words are never split.
    const fitted = pdfSafe(text).split(/( +)/).map((tok) => {
      if (tok.trim() === "" || doc.getTextWidth(tok) <= width) return tok;
      const parts: string[] = [];
      let cur = "";
      for (const ch of tok) {
        if (cur && doc.getTextWidth(cur + ch) > width) { parts.push(cur); cur = ""; }
        cur += ch;
      }
      return [...parts, cur].join(" ");
    }).join("");
    return doc.splitTextToSize(fitted, width) as string[];
  };

  /** Writes wrapped lines, breaking across pages line by line. Returns nothing; advances y. */
  const write = (text: string, o: { size?: number; style?: "normal" | "bold" | "italic"; family?: "helvetica" | "courier"; color?: RGB; indent?: number; after?: number; width?: number } = {}) => {
    const size = o.size ?? 9.5;
    const family = o.family ?? "helvetica";
    const lh = size * (family === "courier" ? 1.3 : 1.42);
    const width = (o.width ?? CW) - (o.indent ?? 0);
    for (const line of wrap(text, width, size, family, o.style)) {
      ensure(lh);
      font(o.style ?? "normal", size, family, o.color ?? INK);
      doc.text(line, ML + (o.indent ?? 0), y + size);
      y += lh;
    }
    y += o.after ?? 0;
  };

  // ----- title block -----
  font("bold", 9, "helvetica", ACCENT);
  doc.text("S O C   S E N T I N E L", ML, y + 9);
  y += 18;
  write(model.title, { size: 21, style: "bold", after: 4 });
  doc.setDrawColor(...ACCENT); doc.setLineWidth(1.2); doc.line(ML, y, ML + 64, y); y += 14;
  if (model.watermark) {
    const lines = wrap(model.watermark, CW - 24, 11, "helvetica", "bold");
    const h = lines.length * 15 + 14;
    ensure(h);
    doc.setFillColor(252, 235, 236); doc.setDrawColor(...TONE.bad); doc.setLineWidth(0.8); doc.rect(ML, y, CW, h, "FD");
    lines.forEach((l, i) => { font("bold", 11, "helvetica", TONE.bad); doc.text(l, ML + 12, y + 18 + i * 15); });
    y += h + 12;
  }
  const kv = (rows: [string, string][], labelW = 128) => {
    for (const [k, v] of rows) {
      const lines = wrap(v, CW - labelW, 9.5);
      const h = Math.max(lines.length, 1) * 13.5 + 4;
      ensure(h);
      font("bold", 7.5, "helvetica", MUTED);
      doc.text(pdfSafe(k).toUpperCase(), ML, y + 8.5);
      lines.forEach((l, i) => { font("normal", 9.5); doc.text(l, ML + labelW, y + 9.5 + i * 13.5); });
      y += h;
    }
    y += 4;
  };
  kv(model.meta);

  // ----- blocks -----
  const heading = (title: string, n: number | null) => {
    ensure(64);
    y += 12;
    font("bold", 7.5, "helvetica", ACCENT);
    if (n !== null) doc.text(String(n).padStart(2, "0"), ML, y + 10);
    font("bold", 12.5, "helvetica", INK);
    doc.text(pdfSafe(title), ML + (n !== null ? 24 : 0), y + 11);
    y += 18;
    doc.setDrawColor(...RULE); doc.setLineWidth(0.6); doc.line(ML, y, W - MR, y);
    y += 10;
  };

  const drawTable = (b: Extract<Block, { t: "table" }>) => {
    const widths = b.cols.map((c) => c.w * CW);
    const header = () => {
      ensure(24);
      font("bold", 7.5, "helvetica", MUTED);
      let x = ML;
      b.cols.forEach((c, i) => { doc.text(pdfSafe(c.label).toUpperCase(), x + 3, y + 8); x += widths[i]!; });
      y += 13;
      doc.setDrawColor(...INK); doc.setLineWidth(0.6); doc.line(ML, y, W - MR, y);
      y += 3;
    };
    header();
    for (const row of b.rows) {
      const cells = row.map((cell, i) => {
        const c = b.cols[i]!;
        const size = c.mono ? 7.3 : 8.3;
        return { lines: wrap(cell, widths[i]! - 6, size, c.mono ? "courier" : "helvetica"), size, mono: c.mono };
      });
      const lh = 10.5;
      const h = Math.max(...cells.map((c) => c.lines.length)) * lh + 6;
      if (y + h > H - BOT) { newPage(); header(); }
      let x = ML;
      cells.forEach((c, i) => {
        font("normal", c.size, c.mono ? "courier" : "helvetica");
        c.lines.forEach((l, li) => doc.text(l, x + 3, y + 3 + c.size + li * lh));
        x += widths[i]!;
      });
      y += h;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.4); doc.line(ML, y, W - MR, y);
    }
    y += 8;
  };

  const drawBlock = (b: Block) => {
    switch (b.t) {
      case "para": write(b.text, { color: b.muted ? MUTED : INK, after: 6 }); break;
      case "sub": ensure(30); y += 6; write(b.text, { size: 9.5, style: "bold", family: "courier", color: ACCENT, after: 2 }); break;
      case "kv": kv(b.rows); break;
      case "note": {
        const lines = wrap(b.text, CW - 24, 9, "helvetica", "bold");
        const h = lines.length * 12.5 + 12;
        ensure(h);
        doc.setFillColor(244, 247, 246); doc.setDrawColor(...MUTED); doc.setLineWidth(0.6); doc.setLineDashPattern([3, 2], 0); doc.rect(ML, y, CW, h, "FD"); doc.setLineDashPattern([], 0);
        lines.forEach((l, i) => { font("bold", 9, "helvetica", INK); doc.text(l, ML + 12, y + 15 + i * 12.5); });
        y += h + 8;
        break;
      }
      case "list":
        for (const it of b.items) {
          const color = it.tone ? TONE[it.tone] : INK;
          if (it.head) write(it.head, { style: "bold", color, indent: 10, after: 1 });
          write(it.head ? it.text : `- ${it.text}`, { indent: 10, after: it.head ? 7 : 4, color: INK });
        }
        break;
      case "table": drawTable(b); break;
      case "mono": {
        const lines = wrap(b.text, CW - 14, 7.6, "courier");
        const lh = 9.9;
        for (const l of lines) {
          ensure(lh);
          doc.setDrawColor(...RULE); doc.setLineWidth(1); doc.line(ML + 3, y - 1, ML + 3, y + lh - 1);
          font("normal", 7.6, "courier"); doc.text(l, ML + 10, y + 7.6);
          y += lh;
        }
        y += 6;
        break;
      }
    }
  };

  model.sections.forEach((sec, i) => {
    heading(sec.title, sec.id === "appendix" ? null : i + 1);
    sec.blocks.forEach(drawBlock);
  });

  // ----- running header / footer / watermark on every page -----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font("bold", 7.5, "helvetica", ACCENT);
    doc.text("SOC SENTINEL", ML, 40);
    font("normal", 7.5, "helvetica", MUTED);
    doc.text("Forensic investigation report", ML + 66, 40);
    doc.text(`Case ${pdfSafe(model.caseId)}`, W - MR, 40, { align: "right" });
    doc.setDrawColor(...RULE); doc.setLineWidth(0.6); doc.line(ML, 48, W - MR, 48);
    doc.line(ML, H - 46, W - MR, H - 46);
    font("normal", 7, "helvetica", MUTED);
    doc.text(`Page ${p} of ${pages}`, ML, H - 32);
    doc.text(`Generated ${model.generatedAt} · ${sourceLabel(model.source)}`, W / 2, H - 32, { align: "center" });
    doc.text("Containment is a dry run", W - MR, H - 32, { align: "right" });
    if (model.watermark) {
      doc.saveGraphicsState();
      doc.setGState(new (doc as unknown as { GState: new (o: { opacity: number }) => never }).GState({ opacity: 0.11 }));
      font("bold", WATERMARK.size, "helvetica", TONE.bad);
      doc.text(model.watermark, W / 2, H / 2, { align: "center", angle: WATERMARK.angle });
      doc.restoreGraphicsState();
    }
  }

  const buf = doc.output("arraybuffer");
  const bytes = new Uint8Array(buf);
  return { blob: new Blob([bytes], { type: "application/pdf" }), bytes, pages };
}
