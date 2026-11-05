import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, newId, audit, one, isUniqueViolation } from "../db";
import { inr, parsePercentBp, parseRupees, pct, fmtDate } from "../domain/gst";
import { stockByProduct, type Product } from "../services/inventory";
import { h, page, form, field, pageHead, empty, opt, rupeesValue, money } from "./ui";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const rows = await stockByProduct(c.env.DB);
  const body = h`${pageHead("Products", h`<a class="btn" href="/products/new">Add product</a>`, "Your catalogue, GST rate and default selling price.")}
  ${rows.length ? h`<div class="tablewrap"><table><thead><tr><th>SKU</th><th>Product</th><th>HSN</th><th class="r">GST</th><th class="r">MRP</th><th class="r">Rate (ex-GST)</th><th class="r">In stock</th><th class="r">Reorder at</th><th></th></tr></thead><tbody>
    ${rows.map((p) => h`<tr><td>${p.sku}</td><td><a href="/products/${p.id}">${p.name}</a> ${p.size ? h`<span class="muted">${p.size}</span>` : ""} ${p.active ? "" : h`<span class="pill">inactive</span>`}</td>
      <td>${p.hsn}</td><td class="r">${pct(p.gst_rate_bp)}</td><td class="r">${p.mrp_paise ? inr(p.mrp_paise) : "—"}</td><td class="r">${p.price_paise ? inr(p.price_paise) : h`<span class="pill warn">not set</span>`}</td>
      <td class="r">${p.on_hand} ${p.on_hand <= p.reorder_level && p.active ? h`<span class="pill warn">low</span>` : ""}</td><td class="r">${p.reorder_level}</td>
      <td><a href="/stock?product=${p.id}">stock</a></td></tr>`)}
  </tbody></table></div>` : empty("No products yet.")}`;
  return page(c, "Products", body);
});

function productForm(p: Partial<Product>, action: string) {
  return h`<form method="post" action="${action}" class="stack panel">
    <div class="row">${field("SKU / code", h`<input name="sku" required maxlength="30" value="${p.sku ?? ""}">`)}
      ${field("Pack size", h`<input name="size" maxlength="30" placeholder="e.g. 50 ml" value="${p.size ?? ""}">`)}</div>
    ${field("Product name (as on the invoice)", h`<input name="name" required maxlength="120" value="${p.name ?? ""}">`)}
    <div class="row">${field("HSN code", h`<input name="hsn" required pattern="[0-9]{4,8}" value="${p.hsn ?? "3304"}">`, "3304 covers skin-care preparations; confirm each with your CA.")}
      ${field("GST rate", h`<select name="gst">${["0", "5", "12", "18", "28", "40"].map((r) => opt(r, r + "%", String((p.gst_rate_bp ?? 1800) / 100)))}</select>`)}
      ${field("Unit", h`<select name="unit">${["NOS", "PCS", "BOX", "PAC", "SET"].map((u) => opt(u, u, p.unit ?? "NOS"))}</select>`, "Unit quantity code for GST returns.")}</div>
    <div class="row">${field("MRP (₹, incl. GST)", h`<input name="mrp" inputmode="decimal" value="${rupeesValue(p.mrp_paise)}">`)}
      ${field("Default selling rate (₹, before GST)", h`<input name="price" inputmode="decimal" value="${rupeesValue(p.price_paise)}">`, "Pre-filled on invoices; can be changed per line.")}
      ${field("Reorder when stock falls to", h`<input name="reorder" type="number" min="0" value="${p.reorder_level ?? 0}">`)}</div>
    <label><input type="checkbox" name="active" value="1" style="width:auto" ${p.active === 0 ? "" : h`checked`}> Active (can be invoiced)</label>
    <div class="actions"><button>Save product</button><a class="btn btn-ghost" href="/products">Cancel</a></div></form>`;
}

async function readProduct(c: any) {
  const { get } = await form(c);
  const v = {
    sku: get("sku").toUpperCase(), name: get("name"), size: get("size"), hsn: get("hsn"), unit: get("unit") || "NOS",
    gst_rate_bp: parsePercentBp(get("gst")) ?? -1, mrp_paise: parseRupees(get("mrp")) ?? 0, price_paise: parseRupees(get("price")),
    reorder_level: Math.max(0, parseInt(get("reorder") || "0", 10) || 0), active: get("active") ? 1 : 0,
  };
  let error: string | undefined;
  if (!v.sku || !v.name) error = "SKU and name are required.";
  else if (!/^\d{4,8}$/.test(v.hsn)) error = "HSN must be 4 to 8 digits.";
  else if (v.gst_rate_bp < 0 || v.gst_rate_bp > 4000) error = "Choose a GST rate.";
  else if (get("price") && v.price_paise == null) error = "Selling rate should be an amount like 450 or 450.50.";
  return { v: { ...v, price_paise: v.price_paise ?? 0 }, error };
}

app.get("/new", (c) => page(c, "Add product", h`${pageHead("Add product")}${productForm({}, "/products/new")}`));
app.post("/new", async (c) => {
  const { v, error } = await readProduct(c);
  if (error) return page(c, "Add product", h`${pageHead("Add product")}${productForm(v, "/products/new")}`, { error });
  const id = newId("prd");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO products (id, sku, name, size, hsn, gst_rate_bp, unit, mrp_paise, price_paise, reorder_level, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, v.sku, v.name, v.size, v.hsn, v.gst_rate_bp, v.unit, v.mrp_paise, v.price_paise, v.reorder_level, v.active),
      audit(c.env.DB, c.get("user").id, "create", "product", id, v),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return page(c, "Add product", h`${pageHead("Add product")}${productForm(v, "/products/new")}`, { error: `SKU ${v.sku} is already used.` });
    throw e;
  }
  return c.redirect("/products?ok=saved");
});

app.get("/:id", async (c) => {
  const p = await one<Product>(c.env.DB, "SELECT * FROM products WHERE id = ?", c.req.param("id"));
  if (!p) throw new HttpError(404, "Product not found.");
  const batches = await c.env.DB.prepare("SELECT * FROM batches WHERE product_id = ? ORDER BY on_hand = 0, expiry_date").bind(p.id).all<any>().then((r) => r.results);
  return page(c, p.name, h`${pageHead(p.name, h`<a class="btn btn-ghost" href="/stock/receive?product=${p.id}">Receive stock</a>`, `${p.sku} · HSN ${p.hsn} · GST ${pct(p.gst_rate_bp)}`)}
    ${productForm(p, `/products/${p.id}`)}
    <h2>Batches</h2>${batches.length ? h`<table><thead><tr><th>Batch</th><th>Mfg</th><th>Expiry</th><th class="r">Cost</th><th class="r">On hand</th></tr></thead><tbody>
    ${batches.map((b: any) => h`<tr><td>${b.batch_no}</td><td>${fmtDate(b.mfg_date)}</td><td>${fmtDate(b.expiry_date)}</td><td class="r">${money(b.cost_paise)}</td><td class="r">${b.on_hand}</td></tr>`)}</tbody></table>` : empty("No stock received yet.")}`);
});
app.post("/:id", async (c) => {
  const id = c.req.param("id");
  const { v, error } = await readProduct(c);
  if (error) return page(c, "Edit product", h`${pageHead("Edit product")}${productForm({ ...v, id }, `/products/${id}`)}`, { error });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE products SET sku = ?, name = ?, size = ?, hsn = ?, gst_rate_bp = ?, unit = ?, mrp_paise = ?, price_paise = ?, reorder_level = ?, active = ? WHERE id = ?")
        .bind(v.sku, v.name, v.size, v.hsn, v.gst_rate_bp, v.unit, v.mrp_paise, v.price_paise, v.reorder_level, v.active, id),
      audit(c.env.DB, c.get("user").id, "update", "product", id, v),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return page(c, "Edit product", h`${pageHead("Edit product")}${productForm({ ...v, id }, `/products/${id}`)}`, { error: `SKU ${v.sku} is already used.` });
    throw e;
  }
  return c.redirect("/products?ok=saved");
});

export default app;
