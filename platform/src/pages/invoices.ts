import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, all, one } from "../db";
import { amountInWords, fmtDate, inr, isDate, parsePercentBp, parseRupees, pct, stateName, todayIst } from "../domain/gst";
import { batchesInStock, stockByProduct } from "../services/inventory";
import { PAY_METHODS, cancelInvoice, createInvoice, deletePayment, recordPayment, type Customer, type Invoice, type InvoiceLine } from "../services/invoices";
import { h, page, form, field, pageHead, empty, opt, money, csv, Raw } from "./ui";

const app = new Hono<AppEnv>();

function statusPill(i: { status: string; total_paise: number; paid_paise: number; due_date: string }, today = todayIst()) {
  if (i.status === "cancelled") return h`<span class="pill">cancelled</span>`;
  if (i.paid_paise >= i.total_paise) return h`<span class="pill ok">paid</span>`;
  if (i.due_date < today) return h`<span class="pill bad">overdue</span>`;
  return i.paid_paise ? h`<span class="pill warn">part paid</span>` : h`<span class="pill warn">due</span>`;
}

app.get("/", async (c) => {
  const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month")! : "";
  const show = c.req.query("show") ?? "";
  const where: string[] = [], p: unknown[] = [];
  if (month) { where.push("i.date LIKE ?"); p.push(month + "-%"); }
  if (show === "unpaid") where.push("i.status = 'issued' AND i.paid_paise < i.total_paise");
  if (show === "cancelled") where.push("i.status = 'cancelled'");
  const rows = await all<Invoice & { customer: string }>(c.env.DB, `SELECT i.*, c.name AS customer FROM invoices i JOIN customers c ON c.id = i.customer_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.date DESC, i.fy DESC, i.seq DESC LIMIT ${c.req.query("format") === "csv" ? 20000 : 300}`, ...p);
  if (c.req.query("format") === "csv") {
    return c.body(csv([["Invoice", "Date", "Customer", "GSTIN", "Place of supply", "Taxable", "CGST", "SGST", "IGST", "Round off", "Total", "Paid", "Status"],
      ...rows.map((i) => { const b = JSON.parse(i.bill_to_json); return [i.number, i.date, b.name, b.gstin, i.place_of_supply, i.taxable_paise / 100, i.cgst_paise / 100, i.sgst_paise / 100, i.igst_paise / 100, i.round_off_paise / 100, i.total_paise / 100, i.paid_paise / 100, i.status]; })]),
      200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="invoices${month ? "-" + month : ""}.csv"` });
  }
  const issued = rows.filter((r) => r.status === "issued");
  const qs = new URLSearchParams({ ...(month ? { month } : {}), ...(show ? { show } : {}), format: "csv" });
  return page(c, "Invoices", h`${pageHead("Invoices", h`<a class="btn" href="/invoices/new">New invoice</a><a class="btn btn-ghost" href="/invoices?${qs.toString()}">Download CSV</a>`)}
    <form class="filters" method="get">${field("Month", h`<input type="month" name="month" value="${month}">`)}
      ${field("Show", h`<select name="show">${opt("", "All", show)}${opt("unpaid", "Unpaid only", show)}${opt("cancelled", "Cancelled", show)}</select>`)}<button class="btn btn-ghost">Filter</button></form>
    ${rows.length ? h`<div class="tablewrap"><table><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">Total</th><th class="r">Due</th><th></th></tr></thead><tbody>
    ${rows.map((i) => h`<tr><td><a href="/invoices/${i.id}">${i.number}</a></td><td>${fmtDate(i.date)}</td><td>${i.customer}</td><td class="r">${money(i.taxable_paise)}</td>
      <td class="r">${money(i.cgst_paise + i.sgst_paise + i.igst_paise)}</td><td class="r">${money(i.total_paise)}</td>
      <td class="r">${i.status === "issued" && i.total_paise > i.paid_paise ? money(i.total_paise - i.paid_paise) : "—"}</td><td>${statusPill(i)}</td></tr>`)}
    </tbody><tfoot><tr><td colspan="3">${issued.length} issued</td><td class="r">${money(issued.reduce((a, i) => a + i.taxable_paise, 0))}</td>
      <td class="r">${money(issued.reduce((a, i) => a + i.cgst_paise + i.sgst_paise + i.igst_paise, 0))}</td><td class="r">${money(issued.reduce((a, i) => a + i.total_paise, 0))}</td>
      <td class="r">${money(issued.reduce((a, i) => a + i.total_paise - i.paid_paise, 0))}</td><td></td></tr></tfoot></table></div>` : empty("No invoices for this filter.")}`);
});

interface Draft { customer_id: string; date: string; notes: string; lines: { product_id: string; batch_id: string; qty: string; rate: string; discount: string }[] }

async function newForm(c: any, d: Draft) {
  const [customers, products, batches] = await Promise.all([
    all<Customer>(c.env.DB, "SELECT * FROM customers WHERE active = 1 ORDER BY name"), stockByProduct(c.env.DB, true), batchesInStock(c.env.DB),
  ]);
  if (!customers.length) return h`${pageHead("New invoice")}${empty("Add a customer first.")}<p><a class="btn" href="/customers/new">Add customer</a></p>`;
  const rows = [...d.lines];
  while (rows.length < 5) rows.push({ product_id: "", batch_id: "", qty: "", rate: "", discount: "" });
  return h`${pageHead("New invoice", undefined, "GST is worked out from each product's rate. Customers outside your state are billed IGST.")}
  <form method="post" action="/invoices/new" class="panel stack" style="max-width:none">
    <div class="row">${field("Customer", h`<select name="customer_id" required><option value="">Choose…</option>${customers.map((cu) => opt(cu.id, `${cu.name}${cu.city ? " · " + cu.city : ""}${cu.gstin ? "" : " (unregistered)"}`, d.customer_id))}</select>`)}
      ${field("Invoice date", h`<input type="date" name="date" required max="${todayIst()}" value="${d.date}">`)}</div>
    <div class="tablewrap"><table class="lines"><thead><tr><th style="width:34%">Product</th><th style="width:26%">Batch</th><th>Qty</th><th>Rate ₹ (ex-GST)</th><th>Disc. %</th></tr></thead><tbody>
    ${rows.map((l) => h`<tr><td data-label="Product"><select name="product_id"><option value="">—</option>${products.map((p) => opt(p.id, `${p.sku} · ${p.name} (${p.on_hand} in stock${p.price_paise ? ", " + inr(p.price_paise) : ""})`, l.product_id))}</select></td>
      <td data-label="Batch"><select name="batch_id"><option value="">Earliest expiry first</option>${batches.map((b) => opt(b.id, `${b.sku} · ${b.batch_no} · exp ${b.expiry_date ?? "—"} (${b.on_hand})`, l.batch_id))}</select></td>
      <td data-label="Qty"><input name="qty" type="number" min="1" inputmode="numeric" value="${l.qty}" class="w-qty"></td>
      <td data-label="Rate ₹ (ex-GST)"><input name="rate" inputmode="decimal" placeholder="default" value="${l.rate}" class="w-rate"></td>
      <td data-label="Disc. %"><input name="discount" inputmode="decimal" placeholder="0" value="${l.discount}" class="w-disc"></td></tr>`)}
    </tbody></table></div>
    <p><button type="button" class="btn btn-ghost" data-add-line>Add another line</button></p>
    ${field("Notes on the invoice (optional)", h`<input name="notes" maxlength="500" value="${d.notes}" placeholder="e.g. PO number, delivery details">`)}
    <div class="actions"><button type="submit">Issue invoice</button><a class="btn btn-ghost" href="/invoices">Cancel</a></div>
    <p class="small muted">Issuing takes the goods out of stock and uses the next invoice number. An issued invoice can be cancelled but not edited or deleted.</p>
  </form>`;
}

app.get("/new", async (c) => page(c, "New invoice", await newForm(c, { customer_id: c.req.query("customer") ?? "", date: todayIst(), notes: "", lines: [] })));
app.post("/new", async (c) => {
  const { get, all: list } = await form(c);
  const pids = list("product_id"), bids = list("batch_id"), qtys = list("qty"), rates = list("rate"), discs = list("discount");
  const d: Draft = {
    customer_id: get("customer_id"), date: get("date"), notes: get("notes"),
    lines: pids.map((product_id, i) => ({ product_id, batch_id: bids[i] ?? "", qty: qtys[i] ?? "", rate: rates[i] ?? "", discount: discs[i] ?? "" })).filter((l) => l.product_id || l.qty),
  };
  try {
    if (!isDate(d.date)) throw new HttpError(400, "Enter the invoice date.");
    const lines = d.lines.map((l) => {
      if (!l.product_id) throw new HttpError(400, "Choose a product on every line that has a quantity.");
      const rate = l.rate ? parseRupees(l.rate) : null, disc = parsePercentBp(l.discount);
      if (l.rate && rate == null) throw new HttpError(400, `"${l.rate}" isn't a valid rate.`);
      if (disc == null) throw new HttpError(400, `"${l.discount}" isn't a valid discount.`);
      return { product_id: l.product_id, batch_id: l.batch_id || undefined, qty: Number(l.qty), rate_paise: rate, discount_bp: disc };
    });
    const inv = await createInvoice(c.env.DB, c.get("user").id, { customer_id: d.customer_id, date: d.date, notes: d.notes, lines });
    return c.redirect(`/invoices/${inv.id}?ok=issued`);
  } catch (e) {
    if (e instanceof HttpError) return page(c, "New invoice", await newForm(c, d), { error: e.message });
    throw e;
  }
});

export function taxInvoice(inv: Invoice, lines: InvoiceLine[]): Raw {
  const s = JSON.parse(inv.seller_json), b = JSON.parse(inv.bill_to_json);
  const inter = !!inv.interstate;
  const hsn = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const k = `${l.hsn}|${l.gst_rate_bp}`, r = hsn.get(k) ?? { hsn: l.hsn, rate: l.gst_rate_bp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable_paise; r.cgst += l.cgst_paise; r.sgst += l.sgst_paise; r.igst += l.igst_paise; hsn.set(k, r);
  }
  const tax = inv.cgst_paise + inv.sgst_paise + inv.igst_paise;
  return h`<article class="invoice">
    <div class="inv-head"><div><img src="/logo-brown.svg" alt="" width="104" height="48" style="margin-bottom:8px"><h2>${s.name}</h2>
      <div class="small" style="white-space:pre-line">${s.address}</div>
      <div class="small">${s.gstin ? h`GSTIN <b>${s.gstin}</b> · ` : ""}State ${stateName(s.state_code)}</div>
      <div class="small muted">${[s.phone, s.email].filter(Boolean).join(" · ")}</div></div>
      <div class="inv-title"><div class="k small muted" style="letter-spacing:.1em;text-transform:uppercase">Tax invoice</div><h2>${inv.number}</h2>
        <div class="small">Date ${fmtDate(inv.date)}<br>Due ${fmtDate(inv.due_date)}</div>
        ${inv.status === "cancelled" ? h`<p style="margin-top:10px"><span class="stamp">CANCELLED</span></p>` : ""}</div></div>
    <div class="inv-parties"><div><div class="k">Bill to</div><b>${b.name}</b><div class="small" style="white-space:pre-line">${b.address}</div>
      <div class="small">${[b.city, b.pincode].filter(Boolean).join(" ")}</div><div class="small">${b.gstin ? h`GSTIN <b>${b.gstin}</b>` : "Unregistered"}</div></div>
      <div class="inv-meta"><div class="k">Place of supply</div>${stateName(inv.place_of_supply)}<div class="k" style="margin-top:8px">Tax</div>${inter ? "IGST (inter-state)" : "CGST + SGST (intra-state)"}
      <div class="k" style="margin-top:8px">Reverse charge</div>No</div></div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Description</th><th>HSN</th><th>Batch · Exp</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc.</th><th class="r">Taxable</th><th class="r">GST</th>
      ${inter ? h`<th class="r">IGST</th>` : h`<th class="r">CGST</th><th class="r">SGST</th>`}<th class="r">Amount</th></tr></thead><tbody>
    ${lines.map((l) => h`<tr><td>${l.line_no}</td><td>${l.description}</td><td>${l.hsn}</td><td class="small">${l.batch_no}${l.expiry_date ? " · " + l.expiry_date.slice(0, 7) : ""}</td>
      <td class="r">${l.qty} ${l.unit}</td><td class="r">${inr(l.rate_paise, false)}</td><td class="r">${l.discount_bp ? pct(l.discount_bp) : ""}</td><td class="r">${inr(l.taxable_paise, false)}</td>
      <td class="r">${pct(l.gst_rate_bp)}</td>${inter ? h`<td class="r">${inr(l.igst_paise, false)}</td>` : h`<td class="r">${inr(l.cgst_paise, false)}</td><td class="r">${inr(l.sgst_paise, false)}</td>`}
      <td class="r">${inr(l.taxable_paise + l.cgst_paise + l.sgst_paise + l.igst_paise, false)}</td></tr>`)}
    </tbody></table></div>
    <div class="inv-foot"><div>
      <div class="tablewrap"><table><thead><tr><th>HSN</th><th class="r">Rate</th><th class="r">Taxable</th>${inter ? h`<th class="r">IGST</th>` : h`<th class="r">CGST</th><th class="r">SGST</th>`}<th class="r">Total tax</th></tr></thead><tbody>
      ${[...hsn.values()].map((r) => h`<tr><td>${r.hsn}</td><td class="r">${pct(r.rate)}</td><td class="r">${inr(r.taxable, false)}</td>${inter ? h`<td class="r">${inr(r.igst, false)}</td>` : h`<td class="r">${inr(r.cgst, false)}</td><td class="r">${inr(r.sgst, false)}</td>`}<td class="r">${inr(r.cgst + r.sgst + r.igst, false)}</td></tr>`)}
      </tbody></table></div>
      <p style="margin-top:12px"><span class="muted">Amount in words:</span><br><b>${amountInWords(inv.total_paise)}</b></p>
      ${inv.notes ? h`<p><span class="muted">Notes:</span> ${inv.notes}</p>` : ""}
      ${s.bank ? h`<p style="white-space:pre-line"><span class="muted">Bank details:</span><br>${s.bank}</p>` : ""}
      ${s.terms ? h`<p class="small muted">${s.terms}</p>` : ""}</div>
      <div><table class="inv-totals" style="border:0"><tbody>
        <tr><td>Taxable value</td><td class="r">${inr(inv.taxable_paise)}</td></tr>
        ${inter ? h`<tr><td>IGST</td><td class="r">${inr(inv.igst_paise)}</td></tr>` : h`<tr><td>CGST</td><td class="r">${inr(inv.cgst_paise)}</td></tr><tr><td>SGST</td><td class="r">${inr(inv.sgst_paise)}</td></tr>`}
        ${inv.round_off_paise ? h`<tr><td>Round off</td><td class="r">${inv.round_off_paise > 0 ? "+" : "−"}${inr(Math.abs(inv.round_off_paise))}</td></tr>` : ""}
        <tr class="grand"><td>Total</td><td class="r">${inr(inv.total_paise)}</td></tr>
        <tr><td class="muted small">of which GST</td><td class="r muted small">${inr(tax)}</td></tr></tbody></table>
        <div class="sign">For ${s.name}<br><br><br>Authorised signatory</div></div></div>
    <p class="small muted" style="margin-top:16px;text-align:center">This is a computer-generated invoice.</p>
  </article>`;
}

async function loadInvoice(db: D1Database, id: string) {
  const inv = await one<Invoice>(db, "SELECT * FROM invoices WHERE id = ?", id);
  if (!inv) throw new HttpError(404, "Invoice not found.");
  const [lines, payments] = await Promise.all([
    all<InvoiceLine>(db, "SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no", id),
    all<any>(db, "SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE invoice_id = ? ORDER BY date, created_at", id),
  ]);
  return { inv, lines, payments };
}

async function viewInvoice(c: any, id: string, error?: string) {
  const { inv, lines, payments } = await loadInvoice(c.env.DB, id);
  const due = inv.total_paise - inv.paid_paise, admin = c.get("user").role === "admin";
  return page(c, inv.number, h`<div class="no-print">${pageHead(inv.number, h`<button type="button" class="btn" data-print>Print / save PDF</button><a class="btn btn-ghost" href="/invoices">All invoices</a>`,
      `${JSON.parse(inv.bill_to_json).name} · ${inr(inv.total_paise)}`)}
    <p>${statusPill(inv)} ${inv.status === "issued" && due > 0 ? h`<b>${inr(due)}</b> still due` : ""} ${inv.cancel_reason ? h`<span class="muted">Reason: ${inv.cancel_reason}</span>` : ""}</p></div>
    ${taxInvoice(inv, lines)}
    <div class="no-print grid2">
      <div class="panel"><h3>Payments</h3>${payments.length ? h`<table style="margin-top:10px"><tbody>${payments.map((p) => h`<tr><td>${fmtDate(p.date)}</td><td>${PAY_METHODS[p.method]} ${p.reference ? h`<span class="muted">· ${p.reference}</span>` : ""}</td>
        <td class="r">${money(p.amount_paise)}</td><td>${admin ? h`<form method="post" action="/invoices/${inv.id}/payments/${p.id}/delete"><button class="link" data-confirm="Remove this payment?">remove</button></form>` : ""}</td></tr>`)}</tbody></table>` : h`<p class="muted">None yet.</p>`}
      ${inv.status === "issued" && due > 0 ? h`<form method="post" action="/invoices/${inv.id}/pay" class="stack" style="margin-top:14px">
        <div class="row">${field("Amount ₹", h`<input name="amount" inputmode="decimal" required value="${(due / 100).toFixed(2)}">`)}${field("Date", h`<input name="date" type="date" required max="${todayIst()}" value="${todayIst()}">`)}</div>
        <div class="row">${field("Method", h`<select name="method">${Object.entries(PAY_METHODS).map(([k, l]) => opt(k, l, "upi"))}</select>`)}${field("Reference", h`<input name="reference" maxlength="120" placeholder="UTR / cheque no.">`)}</div>
        <div><button>Record payment</button></div></form>` : ""}</div>
      ${inv.status === "issued" && inv.paid_paise === 0 ? h`<details class="panel"><summary>Cancel this invoice</summary>
        <p class="small muted">Cancelling returns the goods to stock. The number ${inv.number} stays used and the invoice is kept, marked cancelled. If the goods were delivered and are coming back, a credit note is the right document; talk to your CA.</p>
        <form method="post" action="/invoices/${inv.id}/cancel" class="stack">${field("Reason", h`<input name="reason" required maxlength="300">`)}<div><button class="btn-danger" data-confirm="Cancel invoice ${inv.number}?">Cancel invoice</button></div></form></details>` : ""}
    </div>`, { error, print: true });
}

app.get("/:id", (c) => viewInvoice(c, c.req.param("id")));
app.post("/:id/pay", async (c) => {
  const id = c.req.param("id");
  const { get } = await form(c);
  try {
    const amount = parseRupees(get("amount"));
    if (amount == null || !isDate(get("date"))) throw new HttpError(400, "Enter the amount and date.");
    await recordPayment(c.env.DB, c.get("user").id, { invoice_id: id, amount_paise: amount, date: get("date"), method: get("method"), reference: get("reference") });
  } catch (e) {
    if (e instanceof HttpError && e.status !== 404) return viewInvoice(c, id, e.message);
    throw e;
  }
  return c.redirect(`/invoices/${id}?ok=paid`);
});
app.post("/:id/payments/:pid/delete", async (c) => {
  if (c.get("user").role !== "admin") throw new HttpError(403, "Only an admin can remove payments.");
  const invId = await deletePayment(c.env.DB, c.get("user").id, c.req.param("pid"));
  return c.redirect(`/invoices/${invId}?ok=unpaid`);
});
app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const { get } = await form(c);
  try { await cancelInvoice(c.env.DB, c.get("user").id, id, get("reason")); } catch (e) {
    if (e instanceof HttpError && e.status !== 404) return viewInvoice(c, id, e.message);
    throw e;
  }
  return c.redirect(`/invoices/${id}?ok=cancelled`);
});

export default app;
