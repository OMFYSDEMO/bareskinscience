// A tiny HTML template: every interpolated value is escaped unless it is itself an h`` result. Arrays are joined.
import type { User } from "../env";
import { fmtDate, inr, STATES } from "../domain/gst";

export class Raw { constructor(public readonly html: string) {} toString() { return this.html; } }
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
function render(v: unknown): string {
  if (v == null || v === false) return "";
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}
export function h(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

const NAV: [string, string][] = [["/", "Overview"], ["/invoices", "Invoices"], ["/stock", "Stock"], ["/products", "Products"], ["/customers", "Customers"], ["/reports", "Reports"]];

export function layout(o: { title: string; user?: User | null; path?: string; flash?: string; error?: string; print?: boolean; env?: string }, body: Raw): string {
  const nav = o.user ? h`<header class="top no-print"><div class="wrap top-in">
      <a class="logo" href="/"><img src="/logo-brown.svg" alt="bare Skinscience" width="88" height="40"><span>Ops</span></a>
      <nav>${NAV.map(([href, label]) => h`<a href="${href}" class="${(href === "/" ? o.path === "/" : o.path?.startsWith(href)) ? "on" : ""}">${label}</a>`)}
        ${o.user.role === "admin" ? h`<a href="/settings" class="${o.path?.startsWith("/settings") ? "on" : ""}">Settings</a>` : ""}</nav>
      <form method="post" action="/logout" class="who"><span>${o.user.name}</span><button class="link">Sign out</button></form>
    </div></header>` : "";
  return "<!doctype html>" + h`<html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · bare Ops</title><meta name="robots" content="noindex, nofollow"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css"></head><body class="${o.print ? "printable" : ""}">
${o.env && o.env !== "production" ? h`<div class="envbar no-print">${o.env} — not the live books</div>` : ""}
${nav}<main class="wrap">
${o.flash ? h`<p class="flash ok no-print">${o.flash}</p>` : ""}${o.error ? h`<p class="flash err no-print">${o.error}</p>` : ""}
${body}</main><script src="/app.js" defer></script></body></html>`.html;
}

export const money = (p: number) => h`<span class="num">${inr(p)}</span>`;
export const date = (d: string | null | undefined) => fmtDate(d);
export const opt = (value: string, label: string, selected: unknown) => h`<option value="${value}" ${selected === value ? new Raw("selected") : ""}>${label}</option>`;
export const stateOptions = (sel: string) => Object.entries(STATES).map(([c, n]) => opt(c, `${c} · ${n}`, sel));
export function field(label: string, input: Raw, hint?: string) {
  return h`<label class="field"><span>${label}</span>${input}${hint ? h`<small>${hint}</small>` : ""}</label>`;
}
export const pageHead = (title: string, actions?: Raw, sub?: string) =>
  h`<div class="pagehead"><div><h1>${title}</h1>${sub ? h`<p class="muted">${sub}</p>` : ""}</div>${actions ? h`<div class="actions">${actions}</div>` : ""}</div>`;
export const empty = (text: string) => h`<p class="empty">${text}</p>`;
export const rupeesValue = (p: number | null | undefined) => (p ? (p / 100).toFixed(2) : "");

/** RFC 4180 CSV; cells starting with = + - @ are prefixed so spreadsheets don't run them as formulas. */
export function csv(rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

import type { Context } from "hono";
import type { AppEnv } from "../env";
const FLASH: Record<string, string> = {
  saved: "Saved.", received: "Stock received.", adjusted: "Stock adjusted.", issued: "Invoice issued.", paid: "Payment recorded.",
  cancelled: "Invoice cancelled and stock returned.", unpaid: "Payment removed.", user: "User saved.", welcome: "Welcome. Start by setting your company details and GSTIN.",
};
/** Renders a full page for the signed-in user, with any ?ok= flash message. */
export function page(c: Context<AppEnv>, title: string, body: Raw, o: { error?: string; print?: boolean; status?: number } = {}) {
  const ok = c.req.query("ok");
  return c.html(layout({ title, user: c.get("user"), path: c.req.path, env: c.env.APP_ENV, flash: ok ? FLASH[ok] : undefined, error: o.error, print: o.print }, body), (o.status ?? (o.error ? 400 : 200)) as 200);
}
/** Form body as a plain object; repeated names become arrays via form.getAll. */
export async function form(c: Context<AppEnv>) {
  const f = await c.req.formData();
  const get = (k: string) => String(f.get(k) ?? "").trim();
  return { f, get, all: (k: string) => f.getAll(k).map((v) => String(v).trim()) };
}
