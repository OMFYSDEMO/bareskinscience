import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all, one, getSettings } from "../db";
import { addDays, fmtDate, inr, todayIst } from "../domain/gst";
import { stockByProduct } from "../services/inventory";
import { h, page, pageHead, money, empty } from "./ui";
import { expiryPill } from "./stock";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const db = c.env.DB, today = todayIst(), month = today.slice(0, 7);
  const [settings, products, sales, dues, expiring, recent] = await Promise.all([
    getSettings(db), stockByProduct(db, true),
    one<{ n: number; total: number; taxable: number }>(db, "SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total, COALESCE(SUM(taxable_paise), 0) AS taxable FROM invoices WHERE status = 'issued' AND date LIKE ?", month + "-%"),
    one<{ due: number; overdue: number }>(db, `SELECT COALESCE(SUM(total_paise - paid_paise), 0) AS due,
      COALESCE(SUM(CASE WHEN due_date < ? THEN total_paise - paid_paise END), 0) AS overdue FROM invoices WHERE status = 'issued'`, today),
    all<any>(db, `SELECT b.batch_no, b.expiry_date, b.on_hand, p.sku, p.name FROM batches b JOIN products p ON p.id = b.product_id
      WHERE b.on_hand > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ? ORDER BY b.expiry_date LIMIT 20`, addDays(today, 90)),
    all<any>(db, `SELECT i.id, i.number, i.date, i.total_paise, i.paid_paise, i.status, c.name AS customer FROM invoices i JOIN customers c ON c.id = i.customer_id
      ORDER BY i.created_at DESC LIMIT 8`),
  ]);
  const low = products.filter((p) => p.on_hand <= p.reorder_level);
  const stockValue = products.reduce((a, p) => a + p.value_paise, 0);
  const setupNeeded = !settings.gstin || !settings.address;
  return page(c, "Overview", h`${pageHead("Overview", h`<a class="btn" href="/invoices/new">New invoice</a><a class="btn btn-ghost" href="/stock/receive">Receive stock</a>`)}
    ${setupNeeded ? h`<p class="flash err">Company GSTIN or address is missing, so invoices won't be valid tax invoices yet. ${c.get("user").role === "admin" ? h`<a href="/settings">Add them in Settings</a>.` : "Ask an admin to add them."}</p>` : ""}
    <div class="cards">
      <div class="card"><div class="k">Sales this month</div><div class="v">${inr(sales?.total ?? 0)}</div><div class="small muted">${sales?.n ?? 0} invoices · ${inr(sales?.taxable ?? 0)} before GST</div></div>
      <div class="card"><div class="k">Receivable</div><div class="v">${inr(dues?.due ?? 0)}</div><div class="small muted">${inr(dues?.overdue ?? 0)} overdue</div></div>
      <div class="card"><div class="k">Stock at cost</div><div class="v">${inr(stockValue)}</div><div class="small muted">${products.reduce((a, p) => a + p.on_hand, 0)} units</div></div>
      <div class="card"><div class="k">Needs attention</div><div class="v">${low.length + expiring.length}</div><div class="small muted">${low.length} low · ${expiring.length} batches expiring in 90 days</div></div>
    </div>
    <div class="grid2"><div><h2>Low stock</h2>${low.length ? h`<table><tbody>${low.map((p) => h`<tr><td><a href="/products/${p.id}">${p.name}</a></td><td class="r">${p.on_hand} left</td><td class="r muted">reorder at ${p.reorder_level}</td></tr>`)}</tbody></table>` : empty("All products above their reorder level.")}
      <h2>Expiring within 90 days</h2>${expiring.length ? h`<table><tbody>${expiring.map((b) => h`<tr><td>${b.name}</td><td>batch ${b.batch_no}</td><td>${fmtDate(b.expiry_date)} ${expiryPill(b.expiry_date, today)}</td><td class="r">${b.on_hand}</td></tr>`)}</tbody></table>` : empty("Nothing expiring soon.")}</div>
    <div><h2>Recent invoices</h2>${recent.length ? h`<table><tbody>${recent.map((i) => h`<tr><td><a href="/invoices/${i.id}">${i.number}</a></td><td>${i.customer}</td><td class="r">${money(i.total_paise)}</td>
      <td>${i.status === "cancelled" ? h`<span class="pill">cancelled</span>` : i.paid_paise >= i.total_paise ? h`<span class="pill ok">paid</span>` : h`<span class="pill warn">due</span>`}</td></tr>`)}</tbody></table>` : empty("No invoices yet.")}</div></div>`);
});

export default app;
