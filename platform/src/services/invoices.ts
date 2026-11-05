import { HttpError, newId, audit, all, one, isCheckViolation, getSettings } from "../db";
import { addDays, financialYear, invoiceTotals, lineTax, todayIst, type Totals } from "../domain/gst";
import type { Batch, Product } from "./inventory";

export interface Customer {
  id: string; name: string; kind: string; gstin: string; state_code: string; address: string; city: string; pincode: string;
  contact: string; phone: string; email: string; credit_days: number; active: number;
}
export interface Invoice extends Totals {
  id: string; fy: string; seq: number; number: string; date: string; due_date: string; customer_id: string;
  bill_to_json: string; seller_json: string; place_of_supply: string; interstate: number; paid_paise: number;
  status: "issued" | "cancelled"; notes: string; cancel_reason: string; created_by: string | null; created_at: string;
}
export interface InvoiceLine {
  invoice_id: string; line_no: number; product_id: string; batch_id: string; description: string; batch_no: string;
  expiry_date: string | null; hsn: string; qty: number; unit: string; rate_paise: number; discount_bp: number;
  taxable_paise: number; gst_rate_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number;
}

export interface LineRequest { product_id: string; batch_id?: string; qty: number; rate_paise?: number | null; discount_bp?: number }
export interface InvoiceRequest { customer_id: string; date: string; notes?: string; lines: LineRequest[] }

/**
 * Issues a GST tax invoice and takes the goods out of stock, all in one transaction.
 * Lines without a chosen batch are filled from the batches that expire first (FEFO), splitting across batches if needed.
 * Expired batches are never sold. If stock runs out between the check and the write, the database refuses and nothing is saved.
 */
export async function createInvoice(db: D1Database, userId: string, req: InvoiceRequest): Promise<{ id: string; number: string }> {
  const today = todayIst();
  if (req.date > today) throw new HttpError(400, "The invoice date can't be in the future.");
  const lines = req.lines.filter((l) => l.product_id && l.qty);
  if (!lines.length) throw new HttpError(400, "Add at least one product.");
  if (lines.length > 60) throw new HttpError(400, "An invoice can have at most 60 lines.");
  for (const l of lines) if (!Number.isInteger(l.qty) || l.qty <= 0) throw new HttpError(400, "Quantities must be whole numbers above zero.");

  const [settings, customer] = await Promise.all([getSettings(db), one<Customer>(db, "SELECT * FROM customers WHERE id = ?", req.customer_id)]);
  if (!customer) throw new HttpError(400, "Choose a customer.");
  const fy = financialYear(req.date);
  const last = await one<{ date: string }>(db, "SELECT MAX(date) AS date FROM invoices WHERE fy = ?", fy);
  if (last?.date && req.date < last.date) throw new HttpError(400, `Invoices must be in date order: the last invoice this year is dated ${last.date}.`);

  const interstate = customer.state_code !== settings.state_code;
  const products = new Map((await all<Product>(db, `SELECT * FROM products WHERE id IN (${lines.map(() => "?").join(",")})`, ...lines.map((l) => l.product_id))).map((p) => [p.id, p]));
  const batches = await all<Batch>(db, `SELECT * FROM batches WHERE on_hand > 0 AND product_id IN (${lines.map(() => "?").join(",")})
    ORDER BY expiry_date IS NULL, expiry_date, created_at`, ...lines.map((l) => l.product_id));
  const left = new Map(batches.map((b) => [b.id, b.on_hand]));

  const out: Omit<InvoiceLine, "invoice_id" | "line_no">[] = [];
  for (const l of lines) {
    const p = products.get(l.product_id);
    if (!p) throw new HttpError(400, "One of the products no longer exists.");
    const rate = l.rate_paise ?? p.price_paise;
    if (rate <= 0) throw new HttpError(400, `Set a rate for ${p.name} (or a default price on the product).`);
    const discount = l.discount_bp ?? 0;
    if (discount < 0 || discount > 10000) throw new HttpError(400, "Discount must be between 0% and 100%.");
    const usable = batches.filter((b) => b.product_id === p.id && (!b.expiry_date || b.expiry_date >= req.date) && (!l.batch_id || b.id === l.batch_id));
    let need = l.qty;
    for (const b of usable) {
      if (!need) break;
      const take = Math.min(need, left.get(b.id)!);
      if (take <= 0) continue;
      left.set(b.id, left.get(b.id)! - take);
      need -= take;
      const tax = lineTax({ qty: take, rate_paise: rate, discount_bp: discount, gst_rate_bp: p.gst_rate_bp }, interstate);
      out.push({
        product_id: p.id, batch_id: b.id, description: p.name + (p.size ? ` ${p.size}` : ""), batch_no: b.batch_no, expiry_date: b.expiry_date,
        hsn: p.hsn, qty: take, unit: p.unit, rate_paise: rate, discount_bp: discount, gst_rate_bp: p.gst_rate_bp, ...tax,
      });
    }
    if (need) {
      const have = l.qty - need;
      throw new HttpError(400, `Not enough ${p.name}${l.batch_id ? " in that batch" : ""}: ${have} in sellable stock, ${l.qty} asked.`);
    }
  }
  if (out.length > 100) throw new HttpError(400, "Too many batch lines on one invoice. Split it into two invoices.");

  const totals = invoiceTotals(out);
  const id = newId("inv");
  const billTo = { name: customer.name, gstin: customer.gstin, address: customer.address, city: customer.city, pincode: customer.pincode, state_code: customer.state_code, phone: customer.phone, email: customer.email };
  const seller = { name: settings.company_name, brand: settings.brand_name, gstin: settings.gstin, address: settings.address, state_code: settings.state_code, phone: settings.phone, email: settings.email, bank: settings.bank_details, terms: settings.invoice_terms };
  const prefix = (settings.invoice_prefix || "INV").replace(/[^A-Za-z0-9-]/g, "").slice(0, 5);

  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO invoices (id, fy, seq, number, date, due_date, customer_id, bill_to_json, seller_json, place_of_supply, interstate,
        taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, notes, created_by)
      SELECT ?, ?, s.n, ? || '/' || ? || '/' || printf('%04d', s.n), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM invoices WHERE fy = ?) s`)
      .bind(id, fy, prefix, fy, req.date, addDays(req.date, customer.credit_days), customer.id, JSON.stringify(billTo), JSON.stringify(seller),
        customer.state_code, interstate ? 1 : 0, totals.taxable_paise, totals.cgst_paise, totals.sgst_paise, totals.igst_paise,
        totals.round_off_paise, totals.total_paise, (req.notes ?? "").trim().slice(0, 500), userId, fy),
  ];
  out.forEach((l, i) => {
    stmts.push(
      db.prepare(`INSERT INTO invoice_lines (invoice_id, line_no, product_id, batch_id, description, batch_no, expiry_date, hsn, qty, unit, rate_paise,
          discount_bp, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, igst_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, i + 1, l.product_id, l.batch_id, l.description, l.batch_no, l.expiry_date, l.hsn, l.qty, l.unit, l.rate_paise,
          l.discount_bp, l.taxable_paise, l.gst_rate_bp, l.cgst_paise, l.sgst_paise, l.igst_paise),
      db.prepare("UPDATE batches SET on_hand = on_hand - ? WHERE id = ?").bind(l.qty, l.batch_id),
      db.prepare(`INSERT INTO stock_moves (batch_id, product_id, qty, kind, ref, date, user_id) VALUES (?, ?, ?, 'sale', (SELECT number FROM invoices WHERE id = ?), ?, ?)`)
        .bind(l.batch_id, l.product_id, -l.qty, id, req.date, userId),
    );
  });
  stmts.push(audit(db, userId, "issue", "invoice", id, { total: totals.total_paise }));
  try { await db.batch(stmts); } catch (e) {
    if (isCheckViolation(e)) throw new HttpError(409, "Stock changed while you were preparing this invoice. Please check quantities and try again.");
    throw e;
  }
  const inv = await one<{ number: string }>(db, "SELECT number FROM invoices WHERE id = ?", id);
  return { id, number: inv!.number };
}

// A deliberate CHECK failure (paid_paise = -1) aborts the whole batch when the invoice isn't 'issued',
// so a double click or two people at once can't cancel twice or pay a cancelled invoice.
const guardIssued = (db: D1Database, id: string) =>
  db.prepare("UPDATE invoices SET paid_paise = -1 WHERE id = ? AND status <> 'issued'").bind(id);

/** Cancels an unpaid invoice and returns its goods to the batches they came from. The number stays used. */
export async function cancelInvoice(db: D1Database, userId: string, id: string, reason: string) {
  const inv = await one<Invoice>(db, "SELECT * FROM invoices WHERE id = ?", id);
  if (!inv) throw new HttpError(404, "Invoice not found.");
  if (inv.status !== "issued") throw new HttpError(400, "This invoice is already cancelled.");
  if (inv.paid_paise > 0) throw new HttpError(400, "Remove the payments recorded on this invoice before cancelling it.");
  if (!reason.trim()) throw new HttpError(400, "Give a reason for cancelling.");
  const lines = await all<InvoiceLine>(db, "SELECT * FROM invoice_lines WHERE invoice_id = ?", id);
  const today = todayIst();
  try {
    await db.batch([
      db.prepare("UPDATE invoices SET paid_paise = -1 WHERE id = ? AND (status <> 'issued' OR paid_paise > 0)").bind(id),
      db.prepare("UPDATE invoices SET status = 'cancelled', cancel_reason = ? WHERE id = ?").bind(reason.trim().slice(0, 300), id),
      ...lines.flatMap((l) => [
        db.prepare("UPDATE batches SET on_hand = on_hand + ? WHERE id = ?").bind(l.qty, l.batch_id),
        db.prepare("INSERT INTO stock_moves (batch_id, product_id, qty, kind, ref, date, user_id) VALUES (?, ?, ?, 'sale_cancel', ?, ?, ?)")
          .bind(l.batch_id, l.product_id, l.qty, inv.number, today, userId),
      ]),
      audit(db, userId, "cancel", "invoice", id, { reason }),
    ]);
  } catch (e) {
    if (isCheckViolation(e)) throw new HttpError(409, "This invoice changed in the meantime. Reload and try again.");
    throw e;
  }
}

export const PAY_METHODS: Record<string, string> = { upi: "UPI", bank: "Bank transfer", cash: "Cash", card: "Card", cheque: "Cheque", other: "Other" };

export async function recordPayment(db: D1Database, userId: string, p: { invoice_id: string; date: string; amount_paise: number; method: string; reference: string }) {
  const inv = await one<Invoice>(db, "SELECT * FROM invoices WHERE id = ?", p.invoice_id);
  if (!inv) throw new HttpError(404, "Invoice not found.");
  if (inv.status !== "issued") throw new HttpError(400, "This invoice is cancelled.");
  if (!PAY_METHODS[p.method]) throw new HttpError(400, "Choose how it was paid.");
  if (!(p.amount_paise > 0)) throw new HttpError(400, "Enter the amount received.");
  if (p.date > todayIst()) throw new HttpError(400, "The payment date can't be in the future.");
  const due = inv.total_paise - inv.paid_paise;
  if (p.amount_paise > due) throw new HttpError(400, `That's more than the ₹${(due / 100).toFixed(2)} still due.`);
  const id = newId("pay");
  try {
    await db.batch([
      guardIssued(db, inv.id),
      db.prepare("UPDATE invoices SET paid_paise = paid_paise + ? WHERE id = ?").bind(p.amount_paise, inv.id),
      db.prepare("INSERT INTO payments (id, invoice_id, date, amount_paise, method, reference, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, inv.id, p.date, p.amount_paise, p.method, p.reference.trim().slice(0, 120), userId),
      audit(db, userId, "payment", "invoice", inv.id, { amount: p.amount_paise, method: p.method }),
    ]);
  } catch (e) {
    if (isCheckViolation(e)) throw new HttpError(409, "The amount due changed in the meantime. Reload and try again.");
    throw e;
  }
}

export async function deletePayment(db: D1Database, userId: string, paymentId: string) {
  const p = await one<{ id: string; invoice_id: string; amount_paise: number }>(db, "SELECT id, invoice_id, amount_paise FROM payments WHERE id = ?", paymentId);
  if (!p) throw new HttpError(404, "Payment not found.");
  await db.batch([
    db.prepare("UPDATE invoices SET paid_paise = paid_paise - ? WHERE id = ?").bind(p.amount_paise, p.invoice_id),
    db.prepare("DELETE FROM payments WHERE id = ?").bind(p.id),
    audit(db, userId, "payment_delete", "invoice", p.invoice_id, { amount: p.amount_paise }),
  ]);
  return p.invoice_id;
}
