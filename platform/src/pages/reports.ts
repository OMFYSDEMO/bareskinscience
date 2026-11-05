import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all } from "../db";
import { inr, pct, stateName, todayIst } from "../domain/gst";
import { h, page, pageHead, field, empty, csv } from "./ui";

const app = new Hono<AppEnv>();
const num = (p: number) => (p / 100).toFixed(2);

/** Monthly figures in the shape of GSTR-1: B2B invoice-wise, B2C by state and rate, HSN summary. Hand the CSVs to your CA. */
app.get("/", async (c) => {
  const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month")! : todayIst().slice(0, 7);
  const db = c.env.DB, like = month + "-%";
  const [b2b, b2c, hsn, docs] = await Promise.all([
    all<any>(db, `SELECT i.number, i.date, json_extract(i.bill_to_json, '$.gstin') AS gstin, json_extract(i.bill_to_json, '$.name') AS name, i.place_of_supply, i.total_paise,
        l.gst_rate_bp, SUM(l.taxable_paise) AS taxable, SUM(l.cgst_paise) AS cgst, SUM(l.sgst_paise) AS sgst, SUM(l.igst_paise) AS igst
      FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE i.status = 'issued' AND i.date LIKE ? AND json_extract(i.bill_to_json, '$.gstin') <> ''
      GROUP BY i.id, l.gst_rate_bp ORDER BY i.fy, i.seq`, like),
    all<any>(db, `SELECT i.place_of_supply, l.gst_rate_bp, SUM(l.taxable_paise) AS taxable, SUM(l.cgst_paise) AS cgst, SUM(l.sgst_paise) AS sgst, SUM(l.igst_paise) AS igst
      FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE i.status = 'issued' AND i.date LIKE ? AND json_extract(i.bill_to_json, '$.gstin') = ''
      GROUP BY i.place_of_supply, l.gst_rate_bp ORDER BY i.place_of_supply, l.gst_rate_bp`, like),
    all<any>(db, `SELECT l.hsn, l.unit, l.gst_rate_bp, SUM(l.qty) AS qty, SUM(l.taxable_paise) AS taxable, SUM(l.cgst_paise) AS cgst, SUM(l.sgst_paise) AS sgst, SUM(l.igst_paise) AS igst,
        SUM(l.taxable_paise + l.cgst_paise + l.sgst_paise + l.igst_paise) AS value
      FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE i.status = 'issued' AND i.date LIKE ?
      GROUP BY l.hsn, l.unit, l.gst_rate_bp ORDER BY l.hsn, l.gst_rate_bp`, like),
    all<any>(db, `SELECT MIN(number) AS first, MAX(number) AS last, COUNT(*) AS n, SUM(status = 'cancelled') AS cancelled FROM invoices WHERE date LIKE ?`, like),
  ]);

  const fmt = c.req.query("format"), file = (name: string, rows: unknown[][]) =>
    c.body(csv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}-${month}.csv"` });
  if (fmt === "b2b") return file("gstr1-b2b", [["GSTIN of recipient", "Receiver name", "Invoice number", "Invoice date", "Invoice value", "Place of supply", "Reverse charge", "Rate", "Taxable value", "IGST", "CGST", "SGST"],
    ...b2b.map((r) => [r.gstin, r.name, r.number, r.date, num(r.total_paise), stateName(r.place_of_supply), "N", r.gst_rate_bp / 100, num(r.taxable), num(r.igst), num(r.cgst), num(r.sgst)])]);
  if (fmt === "b2c") return file("gstr1-b2cs", [["Place of supply", "Rate", "Taxable value", "IGST", "CGST", "SGST"],
    ...b2c.map((r) => [stateName(r.place_of_supply), r.gst_rate_bp / 100, num(r.taxable), num(r.igst), num(r.cgst), num(r.sgst)])]);
  if (fmt === "hsn") return file("gstr1-hsn", [["HSN", "UQC", "Total quantity", "Rate", "Total value", "Taxable value", "IGST", "CGST", "SGST"],
    ...hsn.map((r) => [r.hsn, r.unit, r.qty, r.gst_rate_bp / 100, num(r.value), num(r.taxable), num(r.igst), num(r.cgst), num(r.sgst)])]);

  const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + r[k], 0);
  const taxCols = (r: any) => h`<td class="r">${inr(r.taxable)}</td><td class="r">${inr(r.igst)}</td><td class="r">${inr(r.cgst)}</td><td class="r">${inr(r.sgst)}</td>`;
  const totals = (rows: any[], span: number) => h`<tfoot><tr><td colspan="${span}">Total</td>${taxCols({ taxable: sum(rows, "taxable"), igst: sum(rows, "igst"), cgst: sum(rows, "cgst"), sgst: sum(rows, "sgst") })}</tr></tfoot>`;
  const d = docs[0];
  return page(c, "GST reports", h`${pageHead("GST reports", undefined, "Monthly sales figures laid out like GSTR-1. Download the CSVs for your CA or GST software.")}
    <form class="filters" method="get">${field("Month", h`<input type="month" name="month" value="${month}">`)}<button class="btn btn-ghost">Show</button></form>
    <p class="muted">Documents issued: ${d?.n ? `${d.first} to ${d.last} · ${d.n} invoices, ${d.cancelled} cancelled` : "none"}.</p>
    <h2>B2B: registered customers <a class="small" href="/reports?month=${month}&format=b2b">CSV</a></h2>
    ${b2b.length ? h`<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>GSTIN</th><th>POS</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th></tr></thead>
      <tbody>${b2b.map((r) => h`<tr><td>${r.number}</td><td>${r.name}</td><td>${r.gstin}</td><td>${r.place_of_supply}</td><td class="r">${pct(r.gst_rate_bp)}</td>${taxCols(r)}</tr>`)}</tbody>${totals(b2b, 5)}</table></div>` : empty("No B2B sales this month.")}
    <h2>B2C: unregistered customers <a class="small" href="/reports?month=${month}&format=b2c">CSV</a></h2>
    ${b2c.length ? h`<table><thead><tr><th>Place of supply</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th></tr></thead>
      <tbody>${b2c.map((r) => h`<tr><td>${stateName(r.place_of_supply)}</td><td class="r">${pct(r.gst_rate_bp)}</td>${taxCols(r)}</tr>`)}</tbody>${totals(b2c, 2)}</table>` : empty("No B2C sales this month.")}
    <h2>HSN summary <a class="small" href="/reports?month=${month}&format=hsn">CSV</a></h2>
    ${hsn.length ? h`<table><thead><tr><th>HSN</th><th>UQC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th></tr></thead>
      <tbody>${hsn.map((r) => h`<tr><td>${r.hsn}</td><td>${r.unit}</td><td class="r">${r.qty}</td><td class="r">${pct(r.gst_rate_bp)}</td>${taxCols(r)}</tr>`)}</tbody>${totals(hsn, 4)}</table>` : empty("No sales this month.")}
    <p class="small muted" style="margin-top:18px">B2C invoices above ₹1,00,000 to another state (B2CL) are listed with B2C here; flag them to your CA. Credit notes aren't recorded in bare Ops yet.</p>`);
});

export default app;
