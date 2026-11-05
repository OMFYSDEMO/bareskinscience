import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError } from "../db";
import { addDays, fmtDate, inr, isDate, parseRupees, todayIst } from "../domain/gst";
import { ADJUST_REASONS, adjustStock, batchesInStock, receiveStock, stockByProduct, stockMoves } from "../services/inventory";
import { h, page, form, field, pageHead, empty, opt, money, csv } from "./ui";

const app = new Hono<AppEnv>();

export function expiryPill(expiry: string | null, today = todayIst()) {
  if (!expiry) return "";
  if (expiry < today) return h`<span class="pill bad">expired</span>`;
  if (expiry <= addDays(today, 90)) return h`<span class="pill warn">expires soon</span>`;
  return "";
}

app.get("/", async (c) => {
  const productId = c.req.query("product") || undefined;
  const [products, batches] = await Promise.all([stockByProduct(c.env.DB), batchesInStock(c.env.DB, productId)]);
  const total = products.reduce((a, p) => a + p.value_paise, 0);
  const body = h`${pageHead("Stock", h`<a class="btn" href="/stock/receive">Receive stock</a><a class="btn btn-ghost" href="/stock/adjust">Adjust</a><a class="btn btn-ghost" href="/stock/moves">Movements</a>`,
    `Stock value at cost: ${inr(total)}`)}
  <div class="tablewrap"><table><thead><tr><th>Product</th><th class="r">On hand</th><th class="r">Reorder at</th><th>Next expiry</th><th class="r">Value at cost</th></tr></thead><tbody>
    ${products.filter((p) => p.active || p.on_hand).map((p) => h`<tr><td><a href="/stock?product=${p.id}">${p.sku} · ${p.name}</a></td>
      <td class="r">${p.on_hand} ${p.on_hand <= p.reorder_level ? h`<span class="pill warn">low</span>` : ""}</td><td class="r">${p.reorder_level}</td>
      <td>${fmtDate(p.next_expiry)} ${expiryPill(p.next_expiry)}</td><td class="r">${money(p.value_paise)}</td></tr>`)}
  </tbody></table></div>
  <h2>Batches in stock ${productId ? h`<a class="small muted" href="/stock">(show all)</a>` : ""}</h2>
  ${batches.length ? h`<div class="tablewrap"><table><thead><tr><th>Product</th><th>Batch</th><th>Mfg</th><th>Expiry</th><th class="r">Cost / unit</th><th class="r">On hand</th></tr></thead><tbody>
    ${batches.map((b) => h`<tr><td>${b.sku} · ${b.name}</td><td>${b.batch_no}</td><td>${fmtDate(b.mfg_date)}</td><td>${fmtDate(b.expiry_date)} ${expiryPill(b.expiry_date)}</td>
      <td class="r">${money(b.cost_paise)}</td><td class="r">${b.on_hand}</td></tr>`)}</tbody></table></div>` : empty("Nothing in stock.")}`;
  return page(c, "Stock", body);
});

async function receiveForm(c: any, v: Record<string, string> = {}) {
  const products = (await stockByProduct(c.env.DB, true));
  return h`${pageHead("Receive stock", undefined, "Goods in from the manufacturer. Use the batch number and dates printed on the cartons.")}
  <form method="post" action="/stock/receive" class="stack panel">
    ${field("Product", h`<select name="product_id" required><option value="">Choose…</option>${products.map((p) => opt(p.id, `${p.sku} · ${p.name}`, v.product_id))}</select>`)}
    <div class="row">${field("Batch no.", h`<input name="batch_no" required maxlength="40" value="${v.batch_no ?? ""}">`)}
      ${field("Quantity (units)", h`<input name="qty" type="number" min="1" required value="${v.qty ?? ""}">`)}
      ${field("Cost per unit (₹)", h`<input name="cost" inputmode="decimal" value="${v.cost ?? ""}">`, "Landed cost, for stock value.")}</div>
    <div class="row">${field("Mfg date", h`<input name="mfg_date" type="date" value="${v.mfg_date ?? ""}">`)}
      ${field("Expiry date", h`<input name="expiry_date" type="date" value="${v.expiry_date ?? ""}">`)}
      ${field("Received on", h`<input name="date" type="date" required value="${v.date ?? todayIst()}">`)}</div>
    <div class="row">${field("Supplier bill / GRN no.", h`<input name="ref" maxlength="60" value="${v.ref ?? ""}">`)}
      ${field("Note", h`<input name="note" maxlength="200" value="${v.note ?? ""}">`)}</div>
    <div class="actions"><button>Receive</button><a class="btn btn-ghost" href="/stock">Cancel</a></div></form>`;
}
app.get("/receive", async (c) => page(c, "Receive stock", await receiveForm(c, { product_id: c.req.query("product") ?? "" })));
app.post("/receive", async (c) => {
  const { get } = await form(c);
  const v = Object.fromEntries(["product_id", "batch_no", "qty", "cost", "mfg_date", "expiry_date", "date", "ref", "note"].map((k) => [k, get(k)]));
  try {
    if (!isDate(v.date)) throw new HttpError(400, "Enter the date received.");
    if (v.cost && parseRupees(v.cost) == null) throw new HttpError(400, "Cost should be an amount like 120 or 120.50.");
    await receiveStock(c.env.DB, c.get("user").id, {
      product_id: v.product_id, batch_no: v.batch_no, qty: Number(v.qty), cost_paise: v.cost ? parseRupees(v.cost) : null,
      mfg_date: isDate(v.mfg_date) ? v.mfg_date : null, expiry_date: isDate(v.expiry_date) ? v.expiry_date : null, ref: v.ref, note: v.note, date: v.date,
    });
  } catch (e) {
    if (e instanceof HttpError) return page(c, "Receive stock", await receiveForm(c, v), { error: e.message });
    throw e;
  }
  return c.redirect("/stock?ok=received");
});

async function adjustForm(c: any, v: Record<string, string> = {}) {
  const batches = await batchesInStock(c.env.DB);
  return h`${pageHead("Adjust stock", undefined, "Count corrections, damage, samples and testers given to clinics, expired stock written off.")}
  <form method="post" action="/stock/adjust" class="stack panel">
    ${field("Batch", h`<select name="batch_id" required><option value="">Choose…</option>${batches.map((b) => opt(b.id, `${b.sku} · ${b.name} · batch ${b.batch_no} (${b.on_hand} on hand)`, v.batch_id))}</select>`)}
    <div class="row">${field("Change in units", h`<input name="qty" type="number" required value="${v.qty ?? ""}">`, "Negative to remove, e.g. -2.")}
      ${field("Reason", h`<select name="reason" required>${Object.entries(ADJUST_REASONS).map(([k, l]) => opt(k, l, v.reason))}</select>`)}
      ${field("Date", h`<input name="date" type="date" required value="${v.date ?? todayIst()}">`)}</div>
    ${field("Note", h`<input name="note" maxlength="200" value="${v.note ?? ""}" placeholder="e.g. 2 testers to Dr. Nair's clinic">`)}
    <div class="actions"><button>Save adjustment</button><a class="btn btn-ghost" href="/stock">Cancel</a></div></form>`;
}
app.get("/adjust", async (c) => page(c, "Adjust stock", await adjustForm(c)));
app.post("/adjust", async (c) => {
  const { get } = await form(c);
  const v = Object.fromEntries(["batch_id", "qty", "reason", "note", "date"].map((k) => [k, get(k)]));
  try {
    if (!isDate(v.date)) throw new HttpError(400, "Enter a date.");
    await adjustStock(c.env.DB, c.get("user").id, { batch_id: v.batch_id, qty: Number(v.qty), reason: v.reason, note: v.note, date: v.date });
  } catch (e) {
    if (e instanceof HttpError) return page(c, "Adjust stock", await adjustForm(c, v), { error: e.message });
    throw e;
  }
  return c.redirect("/stock?ok=adjusted");
});

const KIND: Record<string, string> = { receipt: "Received", sale: "Sold", sale_cancel: "Invoice cancelled", adjust: "Adjusted" };
app.get("/moves", async (c) => {
  const from = isDate(c.req.query("from")) ? c.req.query("from")! : addDays(todayIst(), -30);
  const to = isDate(c.req.query("to")) ? c.req.query("to")! : todayIst();
  const rows = await stockMoves(c.env.DB, { from, to, limit: c.req.query("format") === "csv" ? 20000 : 500 });
  if (c.req.query("format") === "csv") {
    return c.body(csv([["Date", "SKU", "Product", "Batch", "Movement", "Qty", "Reason", "Reference", "Note", "By"],
      ...rows.map((m) => [m.date, m.sku, m.name, m.batch_no, KIND[m.kind], m.qty, ADJUST_REASONS[m.reason] ?? "", m.ref, m.note, m.user_name ?? ""])]),
      200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="stock-movements-${from}-to-${to}.csv"` });
  }
  return page(c, "Stock movements", h`${pageHead("Stock movements", h`<a class="btn btn-ghost" href="/stock/moves?from=${from}&to=${to}&format=csv">Download CSV</a>`)}
    <form class="filters" method="get">${field("From", h`<input type="date" name="from" value="${from}">`)}${field("To", h`<input type="date" name="to" value="${to}">`)}<button class="btn-ghost btn">Show</button></form>
    ${rows.length ? h`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Product</th><th>Batch</th><th>Movement</th><th class="r">Qty</th><th>Reference / note</th><th>By</th></tr></thead><tbody>
    ${rows.map((m) => h`<tr><td>${fmtDate(m.date)}</td><td>${m.sku} · ${m.name}</td><td>${m.batch_no}</td><td>${KIND[m.kind]}${m.reason ? h` <span class="muted">· ${ADJUST_REASONS[m.reason]}</span>` : ""}</td>
      <td class="r">${m.qty > 0 ? "+" : ""}${m.qty}</td><td>${m.ref} ${m.note ? h`<span class="muted">${m.note}</span>` : ""}</td><td class="muted">${m.user_name ?? ""}</td></tr>`)}</tbody></table></div>` : empty("No movements in this period.")}`);
});

export default app;
