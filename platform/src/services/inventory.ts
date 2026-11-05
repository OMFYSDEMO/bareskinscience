import { HttpError, newId, audit, all, one, isCheckViolation } from "../db";

export interface Product {
  id: string; sku: string; name: string; size: string; hsn: string; gst_rate_bp: number; unit: string;
  mrp_paise: number; price_paise: number; reorder_level: number; active: number;
}
export interface Batch {
  id: string; product_id: string; batch_no: string; mfg_date: string | null; expiry_date: string | null;
  cost_paise: number; on_hand: number;
}

export interface StockRow extends Product { on_hand: number; value_paise: number; next_expiry: string | null }
/** Every product with its total stock, stock value at cost and the earliest expiry among batches still in stock. */
export function stockByProduct(db: D1Database, activeOnly = false) {
  return all<StockRow>(db, `SELECT p.*, COALESCE(SUM(b.on_hand), 0) AS on_hand, COALESCE(SUM(b.on_hand * b.cost_paise), 0) AS value_paise,
      MIN(CASE WHEN b.on_hand > 0 THEN b.expiry_date END) AS next_expiry
    FROM products p LEFT JOIN batches b ON b.product_id = p.id
    ${activeOnly ? "WHERE p.active = 1" : ""} GROUP BY p.id ORDER BY p.active DESC, p.sku`);
}

export interface BatchRow extends Batch { sku: string; name: string }
export function batchesInStock(db: D1Database, productId?: string) {
  return all<BatchRow>(db, `SELECT b.*, p.sku, p.name FROM batches b JOIN products p ON p.id = b.product_id
    WHERE b.on_hand > 0 ${productId ? "AND b.product_id = ?" : ""}
    ORDER BY p.sku, b.expiry_date IS NULL, b.expiry_date, b.created_at`, ...(productId ? [productId] : []));
}

export interface Receipt {
  product_id: string; batch_no: string; mfg_date: string | null; expiry_date: string | null;
  cost_paise: number | null; qty: number; ref: string; note: string; date: string;
}
/** Goods in: adds to an existing batch of the product, or opens a new one. */
export async function receiveStock(db: D1Database, userId: string, r: Receipt): Promise<string> {
  if (!Number.isInteger(r.qty) || r.qty <= 0) throw new HttpError(400, "Quantity received must be a whole number above zero.");
  if (!r.batch_no.trim()) throw new HttpError(400, "Enter the batch number printed on the stock.");
  const product = await one<Product>(db, "SELECT * FROM products WHERE id = ?", r.product_id);
  if (!product) throw new HttpError(400, "Choose a product.");
  if (r.mfg_date && r.expiry_date && r.expiry_date <= r.mfg_date) throw new HttpError(400, "Expiry date must be after the manufacturing date.");

  const existing = await one<Batch>(db, "SELECT * FROM batches WHERE product_id = ? AND batch_no = ?", r.product_id, r.batch_no.trim());
  const batchId = existing?.id ?? newId("bat");
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    if (r.expiry_date && existing.expiry_date && r.expiry_date !== existing.expiry_date)
      throw new HttpError(400, `Batch ${existing.batch_no} is already recorded with expiry ${existing.expiry_date}. Check the batch number.`);
    // Weighted average cost when the same batch arrives again at a different price.
    const cost = r.cost_paise == null ? existing.cost_paise
      : Math.round((existing.cost_paise * existing.on_hand + r.cost_paise * r.qty) / (existing.on_hand + r.qty));
    stmts.push(db.prepare(`UPDATE batches SET on_hand = on_hand + ?, cost_paise = ?, mfg_date = COALESCE(mfg_date, ?), expiry_date = COALESCE(expiry_date, ?) WHERE id = ?`)
      .bind(r.qty, cost, r.mfg_date, r.expiry_date, batchId));
  } else {
    stmts.push(db.prepare("INSERT INTO batches (id, product_id, batch_no, mfg_date, expiry_date, cost_paise, on_hand) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(batchId, r.product_id, r.batch_no.trim(), r.mfg_date, r.expiry_date, r.cost_paise ?? 0, r.qty));
  }
  stmts.push(
    db.prepare("INSERT INTO stock_moves (batch_id, product_id, qty, kind, ref, note, date, user_id) VALUES (?, ?, ?, 'receipt', ?, ?, ?, ?)")
      .bind(batchId, r.product_id, r.qty, r.ref.trim(), r.note.trim(), r.date, userId),
    audit(db, userId, "receive", "batch", batchId, { qty: r.qty, ref: r.ref }),
  );
  await db.batch(stmts);
  return batchId;
}

export const ADJUST_REASONS: Record<string, string> = {
  count: "Stock count correction", damaged: "Damaged", expired: "Expired / written off",
  sample: "Samples & testers", internal: "Internal use", other: "Other",
};
/** Stock correction on one batch. qty is signed: -3 takes three out. */
export async function adjustStock(db: D1Database, userId: string, a: { batch_id: string; qty: number; reason: string; note: string; date: string }) {
  if (!Number.isInteger(a.qty) || a.qty === 0) throw new HttpError(400, "Enter a whole number, e.g. -2 to remove two units or 5 to add five.");
  if (!ADJUST_REASONS[a.reason]) throw new HttpError(400, "Choose a reason.");
  if (a.reason === "other" && !a.note.trim()) throw new HttpError(400, "Add a note explaining the adjustment.");
  const b = await one<Batch>(db, "SELECT * FROM batches WHERE id = ?", a.batch_id);
  if (!b) throw new HttpError(400, "Choose a batch.");
  try {
    await db.batch([
      db.prepare("UPDATE batches SET on_hand = on_hand + ? WHERE id = ?").bind(a.qty, b.id),
      db.prepare("INSERT INTO stock_moves (batch_id, product_id, qty, kind, reason, note, date, user_id) VALUES (?, ?, ?, 'adjust', ?, ?, ?, ?)")
        .bind(b.id, b.product_id, a.qty, a.reason, a.note.trim(), a.date, userId),
      audit(db, userId, "adjust", "batch", b.id, { qty: a.qty, reason: a.reason }),
    ]);
  } catch (e) {
    if (isCheckViolation(e)) throw new HttpError(400, `Batch ${b.batch_no} has only ${b.on_hand} in stock.`);
    throw e;
  }
}

export interface MoveRow { id: number; date: string; kind: string; qty: number; reason: string; ref: string; note: string; batch_no: string; sku: string; name: string; user_name: string | null }
export function stockMoves(db: D1Database, f: { from?: string; to?: string; product_id?: string; limit?: number }) {
  const where: string[] = [], p: unknown[] = [];
  if (f.from) { where.push("m.date >= ?"); p.push(f.from); }
  if (f.to) { where.push("m.date <= ?"); p.push(f.to); }
  if (f.product_id) { where.push("m.product_id = ?"); p.push(f.product_id); }
  return all<MoveRow>(db, `SELECT m.id, m.date, m.kind, m.qty, m.reason, m.ref, m.note, b.batch_no, p.sku, p.name, u.name AS user_name
    FROM stock_moves m JOIN batches b ON b.id = m.batch_id JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.date DESC, m.id DESC LIMIT ${f.limit ?? 500}`, ...p);
}
