import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, all, audit, getSettings, isUniqueViolation, one } from "../db";
import { gstinError } from "../domain/gst";
import { createUser, hashPassword, passwordError } from "../services/auth";
import { h, page, form, field, pageHead, opt, stateOptions } from "./ui";

const app = new Hono<AppEnv>();
const KEYS = ["company_name", "brand_name", "gstin", "address", "state_code", "phone", "email", "invoice_prefix", "bank_details", "invoice_terms"];

async function settingsPage(c: any, error?: string, v?: Record<string, string>) {
  const s = v ?? (await getSettings(c.env.DB));
  const users = await all<any>(c.env.DB, "SELECT id, name, email, role, active FROM users ORDER BY active DESC, name");
  return page(c, "Settings", h`${pageHead("Settings", undefined, "Company details printed on every new invoice. Invoices already issued keep the details they were issued with.")}
    <div class="grid2"><form method="post" action="/settings" class="stack panel">
      <h3>Company</h3>
      ${field("Legal name", h`<input name="company_name" required value="${s.company_name}">`)}
      ${field("Brand", h`<input name="brand_name" value="${s.brand_name}">`)}
      <div class="row">${field("GSTIN", h`<input name="gstin" maxlength="15" style="text-transform:uppercase" value="${s.gstin}">`)}
        ${field("State", h`<select name="state_code">${stateOptions(s.state_code)}</select>`)}</div>
      ${field("Registered address", h`<textarea name="address">${s.address}</textarea>`)}
      <div class="row">${field("Phone", h`<input name="phone" value="${s.phone}">`)}${field("Email", h`<input name="email" type="email" value="${s.email}">`)}</div>
      ${field("Invoice number prefix", h`<input name="invoice_prefix" required pattern="[A-Za-z0-9-]{1,5}" maxlength="5" value="${s.invoice_prefix}">`, "Up to 5 letters/digits. Numbers look like BSS/26-27/0001 and restart each April.")}
      ${field("Bank details (printed on invoices)", h`<textarea name="bank_details" placeholder="Account name, number, IFSC, UPI ID">${s.bank_details}</textarea>`)}
      ${field("Terms (printed on invoices)", h`<textarea name="invoice_terms">${s.invoice_terms}</textarea>`)}
      <div><button>Save settings</button></div></form>
    <div><div class="panel"><h3>Users</h3><table style="margin-top:10px"><tbody>
      ${users.map((u) => h`<tr><td>${u.name}<br><span class="small muted">${u.email}</span></td><td>${u.role}${u.active ? "" : h` <span class="pill">disabled</span>`}</td>
        <td>${u.id !== c.get("user").id ? h`<form method="post" action="/settings/users/${u.id}/toggle"><button class="link">${u.active ? "disable" : "enable"}</button></form>` : h`<span class="muted small">you</span>`}</td></tr>`)}
      </tbody></table></div>
      <form method="post" action="/settings/users" class="stack panel"><h3>Add a user, or reset a password</h3>
        <p class="small muted">Staff can invoice, receive and adjust stock. Admins can also change settings, users and remove payments. Entering an existing email resets that user's password.</p>
        <div class="row">${field("Name", h`<input name="name" required>`)}${field("Email", h`<input name="email" type="email" required>`)}</div>
        <div class="row">${field("Role", h`<select name="role">${opt("staff", "Staff", "staff")}${opt("admin", "Admin", "")}</select>`)}
          ${field("Password", h`<input name="password" type="password" required minlength="10" autocomplete="new-password">`, "Share it with them privately.")}</div>
        <div><button>Save user</button></div></form></div></div>`, { error });
}

app.get("/", (c) => settingsPage(c));
app.post("/", async (c) => {
  const { get } = await form(c);
  const v = Object.fromEntries(KEYS.map((k) => [k, get(k)]));
  v.gstin = v.gstin.toUpperCase().replace(/\s/g, "");
  v.invoice_prefix = v.invoice_prefix.toUpperCase();
  if (v.gstin) v.state_code = v.gstin.slice(0, 2);
  const error = !v.company_name ? "Enter the legal name." : gstinError(v.gstin) ?? (!/^[A-Z0-9-]{1,5}$/.test(v.invoice_prefix) ? "The prefix can have up to 5 letters, digits or hyphens." : undefined);
  if (error) return settingsPage(c, error, v);
  await c.env.DB.batch([
    ...KEYS.map((k) => c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, v[k])),
    audit(c.env.DB, c.get("user").id, "update", "settings", "company", v),
  ]);
  return c.redirect("/settings?ok=saved");
});

app.post("/users", async (c) => {
  const { get } = await form(c);
  const v = { name: get("name"), email: get("email").toLowerCase(), role: get("role") === "admin" ? "admin" as const : "staff" as const, password: get("password") };
  const err = !v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? "Enter a name and a valid email." : passwordError(v.password);
  if (err) return settingsPage(c, err);
  const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM users WHERE email = ?", v.email);
  if (existing) {
    if (existing.id === c.get("user").id && v.role !== "admin") return settingsPage(c, "You can't remove your own admin role.");
    const hp = await hashPassword(v.password);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET name = ?, role = ?, pw_hash = ?, pw_salt = ?, failed = 0, locked_until = NULL WHERE id = ?").bind(v.name, v.role, hp.pw_hash, hp.pw_salt, existing.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(existing.id),
      audit(c.env.DB, c.get("user").id, "reset", "user", existing.id, { role: v.role }),
    ]);
  } else {
    try { await createUser(c.env.DB, c.get("user").id, v); } catch (e) { if (isUniqueViolation(e)) return settingsPage(c, "That email is already used."); throw e; }
  }
  return c.redirect("/settings?ok=user");
});

app.post("/users/:id/toggle", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("user").id) throw new HttpError(400, "You can't disable your own account.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET active = 1 - active WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    audit(c.env.DB, c.get("user").id, "toggle", "user", id),
  ]);
  return c.redirect("/settings?ok=user");
});

export default app;
