import fs from "fs";
import path from "path";

export const SETTLEMENT_PDF_DIR = path.join(process.cwd(), "uploads", "settlements");

export function ensureSettlementPdfDir(campaignId: number): string {
  const dir = path.join(SETTLEMENT_PDF_DIR, String(campaignId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Minimal multi-page text PDF (Helvetica). No extra npm packages.
 * Inputs: title + body lines. Outputs: PDF buffer.
 */
export function buildSimplePdf(title: string, lines: string[]): Buffer {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const fontSize = 10;
  const leading = 14;
  const maxLines = Math.floor((pageHeight - margin * 2 - 28) / leading);
  const wrapped: string[] = [];
  const maxChars = 95;
  for (const raw of [title, "", ...lines]) {
    const line = raw.replace(/\r/g, "");
    if (line.length <= maxChars) {
      wrapped.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > maxChars) {
      wrapped.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    wrapped.push(rest);
  }

  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += maxLines) {
    pages.push(wrapped.slice(i, i + maxLines));
  }
  if (pages.length === 0) pages.push([title]);

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds: number[] = [];
  let nextId = 3;
  const contentIds: number[] = [];
  const fontId = nextId++;
  objects[fontId - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  for (let p = 0; p < pages.length; p++) {
    const contentId = nextId++;
    const pageId = nextId++;
    contentIds.push(contentId);
    pageObjectIds.push(pageId);
    const streamLines = [
      "BT",
      `/F1 ${fontSize} Tf`,
      `${margin} ${pageHeight - margin} Td`,
      `${leading} TL`,
    ];
    pages[p].forEach((line, idx) => {
      const cmd = idx === 0 ? `(${pdfEscape(line)}) Tj` : `T* (${pdfEscape(line)}) Tj`;
      streamLines.push(cmd);
    });
    streamLines.push("ET");
    const stream = streamLines.join("\n");
    objects[contentId - 1] =
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  }

  const kids = pageObjectIds.map((id) => `${id} 0 R`).join(" ");
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`;

  const maxObj = objects.length;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < maxObj; i++) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${maxObj + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= maxObj; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

export function writeSettlementPdf(
  campaignId: number,
  filename: string,
  title: string,
  lines: string[],
): string {
  const dir = ensureSettlementPdfDir(campaignId);
  const full = path.join(dir, filename);
  fs.writeFileSync(full, buildSimplePdf(title, lines));
  return `/uploads/settlements/${campaignId}/${filename}`;
}

export function moneyLine(label: string, amount: number): string {
  return `${label}: $${Number(amount || 0).toFixed(2)}`;
}
