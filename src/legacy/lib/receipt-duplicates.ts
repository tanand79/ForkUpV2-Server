import type { PoolClient, QueryResultRow } from "pg";

export type ReceiptDuplicateProbe = {
  receiptNumber?: string | null;
  dateString?: string | null;
  timeString?: string | null;
  subtotal?: number | null;
  total?: number | null;
};

export type DuplicateReceiptHit = {
  receiptId: number;
  reason: string;
};

function moneyEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.05;
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/**
 * Old EventController check-duplicate-receipt order, scoped to one campaign location.
 * Ignores rejected receipts. excludeReceiptId skips the row being inserted.
 */
export async function findDuplicateReceipt(
  connection: PoolClient,
  campaignId: number,
  locationId: number,
  probe: ReceiptDuplicateProbe,
  excludeReceiptId?: number,
): Promise<DuplicateReceiptHit | null> {
  const receiptNumber = text(probe.receiptNumber);
  const dateString = text(probe.dateString);
  const timeString = text(probe.timeString);
  const subtotal = probe.subtotal != null && probe.subtotal > 0 ? probe.subtotal : null;
  const total = probe.total != null && probe.total > 0 ? probe.total : null;

  const params: Array<string | number> = [campaignId, locationId];
  let excludeClause = "";
  if (excludeReceiptId != null) {
    params.push(excludeReceiptId);
    excludeClause = ` AND id <> $${params.length}`;
  }

  const { rows } = await connection.query<QueryResultRow>(
    `SELECT id, ocr_receipt_number, ocr_date_string, ocr_time_string, subtotal, ocr_total
     FROM receipts
     WHERE campaign_id = $1 AND location_id = $2
       AND review_status <> 'rejected'${excludeClause}`,
    params,
  );

  const candidates = rows.map((r) => ({
    id: Number(r.id),
    receiptNumber: text(r.ocr_receipt_number),
    dateString: text(r.ocr_date_string),
    timeString: text(r.ocr_time_string),
    subtotal: num(r.subtotal),
    total: num(r.ocr_total),
  }));

  if (receiptNumber) {
    const byNumber = candidates.filter((c) => c.receiptNumber === receiptNumber);
    for (const c of byNumber) {
      if (dateString && timeString && c.dateString === dateString && c.timeString === timeString) {
        if (subtotal != null && c.subtotal != null && moneyEq(c.subtotal, subtotal)) {
          return {
            receiptId: c.id,
            reason: "ReceiptNumber + Date + Time + Subtotal matched",
          };
        }
      }
      if (dateString && c.dateString === dateString) {
        if (subtotal != null && c.subtotal != null && moneyEq(c.subtotal, subtotal)) {
          return {
            receiptId: c.id,
            reason: "ReceiptNumber + Date + Subtotal matched",
          };
        }
      }
    }
  }

  if (dateString && timeString) {
    const byDateTime = candidates.filter(
      (c) => c.dateString === dateString && c.timeString === timeString,
    );
    for (const c of byDateTime) {
      if (subtotal != null && c.subtotal != null && moneyEq(c.subtotal, subtotal)) {
        return { receiptId: c.id, reason: "Date + Time + Subtotal matched" };
      }
      if (subtotal == null && total != null && c.subtotal != null && moneyEq(c.subtotal, total)) {
        return { receiptId: c.id, reason: "Date + Time + Total matched" };
      }
    }
  }

  if (dateString) {
    const byDate = candidates.filter((c) => c.dateString === dateString);
    for (const c of byDate) {
      if (subtotal != null && c.subtotal != null && moneyEq(c.subtotal, subtotal)) {
        return { receiptId: c.id, reason: "Date + Subtotal matched" };
      }
      if (subtotal == null && total != null && c.subtotal != null && moneyEq(c.subtotal, total)) {
        return { receiptId: c.id, reason: "Date + Total matched" };
      }
    }
  }

  return null;
}
