import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, newId, audit, all, one } from "../db";
import { fmtDate, gstinError, inr, stateName, todayIst } from "../domain/gst";
import type { Customer } from "../services/invoices";
import { h, page, form, field, pageHead, empty, opt, stateOptions, money } from "./ui";

const app = new Hono<AppEnv>();
export const KINDS: Record<string, string> = { clinic: "Clinic", distributor: "Distributor", retail: "Retailer / pharmacy", consumer: "Consumer" };

app.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const rows = await all<Customer & { due_paise: number; invoices: number }>(c.env.DB, `SELECT c.*,
      COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.total_paise - i.paid_paise END), 0) AS due_paise, COUNT(i.id) AS invoices
    FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id
    ${q ? "WHERE c.name LIKE ? OR c.city LIKE ? OR c.gstin LIKE ? OR c.phone LIKE ?" : ""}
    GROUP BY c.id ORDER BY c.active DESC, c.name`, ...(q ? Array(4).fill(`%${q}%`) : []));
  return page(c, "Customers", h`${pageHead("Customers", h`<a class="btn" href="/customers/new">Add customer</a>`, "Clinics, distributors and other buyers.")}
    <form class="filters" method="get">${field("Search", h`<input name="q" value="${q}" placeholder="Name, city, GSTIN or phone">`)}<button class="btn btn-ghost">Search</button></form>
    ${rows.length ? h`<div class="tablewrap"><table><thead><tr><th>Name</th><th>Type</th><th>City</th><th>GSTIN</th><th>Phone</th><th class="r">Invoices</th><th class="r">Due</th></tr></thead><tbody>
    ${rows.map((r) => h`<tr><td><a href="/customers/${r.id}">${r.name}</a> ${r.active ? "" : h`<span class="pill">inactive</span>`}</td><td>${KINDS[r.kind]}</td><td>${r.city}</td>
      <td>${r.gstin || h`<span class="muted">unregistered</span>`}</td><td>${r.phone}</td><td class="r">${r.invoices}</td><td class="r">${r.due_paise ? money(r.due_paise) : "—"}</td></tr>`)}
    </tbody></table></div>` : empty(q ? "No customers match." : "No customers yet.")}`);
});

function customerForm(v: Partial<Customer>, action: string) {
  return h`<form method="post" action="${action}" class="stack panel">
    <div class="row">${field("Business name (as registered)", h`<input name="name" required maxlength="120" value="${v.name ?? ""}">`)}
      ${field("Type", h`<select name="kind">${Object.entries(KINDS).map(([k, l]) => opt(k, l, v.kind ?? "clinic"))}</select>`)}</div>
    <div class="row">${field("GSTIN", h`<input name="gstin" maxlength="15" style="text-transform:uppercase" value="${v.gstin ?? ""}">`, "Leave blank if unregistered (B2C).")}
      ${field("State (place of supply)", h`<select name="state_code">${stateOptions(v.state_code ?? "32")}</select>`, "Set from the GSTIN automatically when one is given.")}</div>
    ${field("Billing address", h`<textarea name="address" maxlength="300">${v.address ?? ""}</textarea>`)}
    <div class="row">${field("City", h`<input name="city" maxlength="60" value="${v.city ?? ""}">`)}${field("PIN code", h`<input name="pincode" pattern="[0-9]{6}" value="${v.pincode ?? ""}">`)}
      ${field("Credit period (days)", h`<input name="credit_days" type="number" min="0" max="180" value="${v.credit_days ?? 30}">`)}</div>
    <div class="row">${field("Contact person", h`<input name="contact" maxlength="80" value="${v.contact ?? ""}">`)}${field("Phone", h`<input name="phone" maxlength="20" value="${v.phone ?? ""}">`)}
      ${field("Email", h`<input name="email" type="email" maxlength="120" value="${v.email ?? ""}">`)}</div>
    <label><input type="checkbox" name="active" value="1" style="width:auto" ${v.active === 0 ? "" : h`checked`}> Active</label>
    <div class="actions"><button>Save customer</button><a class="btn btn-ghost" href="/customers">Cancel</a></div></form>`;
}

async function readCustomer(c: any) {
  const { get } = await form(c);
  const v = {
    name: get("name"), kind: get("kind") || "clinic", gstin: get("gstin").toUpperCase().replace(/\s/g, ""), state_code: get("state_code") || "32",
    address: get("address"), city: get("city"), pincode: get("pincode"), contact: get("contact"), phone: get("phone"), email: get("email"),
    credit_days: Math.min(180, Math.max(0, parseInt(get("credit_days") || "0", 10) || 0)), active: get("active") ? 1 : 0,
  };
  if (v.gstin) v.state_code = v.gstin.slice(0, 2);
  const error = !v.name ? "Enter the business name." : !KINDS[v.kind] ? "Choose a type." : gstinError(v.gstin) ?? undefined;
  return { v, error };
}

app.get("/new", (c) => page(c, "Add customer", h`${pageHead("Add customer")}${customerForm({}, "/customers/new")}`));
app.post("/new", async (c) => {
  const { v, error } = await readCustomer(c);
  if (error) return page(c, "Add customer", h`${pageHead("Add customer")}${customerForm(v, "/customers/new")}`, { error });
  const id = newId("cus");
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO customers (id, name, kind, gstin, state_code, address, city, pincode, contact, phone, email, credit_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, v.name, v.kind, v.gstin, v.state_code, v.address, v.city, v.pincode, v.contact, v.phone, v.email, v.credit_days, v.active),
    audit(c.env.DB, c.get("user").id, "create", "customer", id, v),
  ]);
  return c.redirect(`/customers/${id}?ok=saved`);
});

app.get("/:id", async (c) => {
  const cu = await one<Customer>(c.env.DB, "SELECT * FROM customers WHERE id = ?", c.req.param("id"));
  if (!cu) throw new HttpError(404, "Customer not found.");
  const invoices = await all<any>(c.env.DB, "SELECT id, number, date, due_date, total_paise, paid_paise, status FROM invoices WHERE customer_id = ? ORDER BY date DESC, seq DESC LIMIT 200", cu.id);
  const due = invoices.filter((i) => i.status === "issued").reduce((a, i) => a + i.total_paise - i.paid_paise, 0);
  const today = todayIst();
  return page(c, cu.name, h`${pageHead(cu.name, h`<a class="btn" href="/invoices/new?customer=${cu.id}">New invoice</a>`, `${KINDS[cu.kind]} · ${stateName(cu.state_code)} · Outstanding ${inr(due)}`)}
    <div class="grid2"><div>${customerForm(cu, `/customers/${cu.id}`)}</div>
    <div><h2 style="margin-top:18px">Invoices</h2>${invoices.length ? h`<table><thead><tr><th>Number</th><th>Date</th><th class="r">Total</th><th class="r">Due</th></tr></thead><tbody>
      ${invoices.map((i) => h`<tr><td><a href="/invoices/${i.id}">${i.number}</a></td><td>${fmtDate(i.date)}</td><td class="r">${money(i.total_paise)}</td>
        <td class="r">${i.status === "cancelled" ? h`<span class="pill">cancelled</span>` : i.total_paise === i.paid_paise ? h`<span class="pill ok">paid</span>` : h`${money(i.total_paise - i.paid_paise)} ${i.due_date < today ? h`<span class="pill bad">overdue</span>` : ""}`}</td></tr>`)}
      </tbody></table>` : empty("No invoices yet.")}</div></div>`);
});
app.post("/:id", async (c) => {
  const id = c.req.param("id");
  const { v, error } = await readCustomer(c);
  if (error) return page(c, "Edit customer", h`${pageHead("Edit customer")}${customerForm({ ...v, id }, `/customers/${id}`)}`, { error });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE customers SET name = ?, kind = ?, gstin = ?, state_code = ?, address = ?, city = ?, pincode = ?, contact = ?, phone = ?, email = ?, credit_days = ?, active = ? WHERE id = ?`)
      .bind(v.name, v.kind, v.gstin, v.state_code, v.address, v.city, v.pincode, v.contact, v.phone, v.email, v.credit_days, v.active, id),
    audit(c.env.DB, c.get("user").id, "update", "customer", id, v),
  ]);
  return c.redirect(`/customers/${id}?ok=saved`);
});

export default app;
