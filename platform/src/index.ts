import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./env";
import { HttpError } from "./db";
import { COOKIE, sessionUser } from "./services/auth";
import { layout, h } from "./pages/ui";
import auth from "./pages/auth";
import overview from "./pages/overview";
import products from "./pages/products";
import stock from "./pages/stock";
import customers from "./pages/customers";
import invoices from "./pages/invoices";
import reports from "./pages/reports";
import settings from "./pages/settings";

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error("unhandled", err);
  const message = err instanceof HttpError ? err.message : "Something went wrong. Please try again.";
  return c.html(layout({ title: "Error", user: c.get("user"), env: c.env.APP_ENV }, h`<div class="panel"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p class="muted">${message}</p><a class="btn" href="/">Back to overview</a></div>`), status as 500);
});

app.use("*", async (c, next) => {
  // Forms only post from this site (with SameSite=Strict cookies this blocks cross-site form posts).
  if (c.req.method === "POST") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.text("Cross-site request refused", 403);
  }
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "same-origin");
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
  c.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (c.env.APP_ENV === "production") c.header("strict-transport-security", "max-age=31536000");
});

app.get("/health", async (c) => {
  const ok = await c.env.DB.prepare("SELECT 1 AS ok").first().then(() => true, () => false);
  return c.json({ ok, env: c.env.APP_ENV }, ok ? 200 : 503);
});

app.route("/", auth); // /login, /logout, /setup: no session needed

app.use("*", async (c, next) => {
  const user = await sessionUser(c.env.DB, getCookie(c, COOKIE));
  if (!user) return c.redirect("/login?next=" + encodeURIComponent(new URL(c.req.url).pathname));
  c.set("user", user);
  await next();
});
app.use("/settings/*", async (c, next) => {
  if (c.get("user").role !== "admin") throw new HttpError(403, "Only an admin can change settings and users.");
  await next();
});
app.use("/settings", async (c, next) => {
  if (c.get("user").role !== "admin") throw new HttpError(403, "Only an admin can change settings and users.");
  await next();
});

app.route("/", overview);
app.route("/products", products);
app.route("/stock", stock);
app.route("/customers", customers);
app.route("/invoices", invoices);
app.route("/reports", reports);
app.route("/settings", settings);

app.notFound((c) => c.html(layout({ title: "Not found", user: c.get("user"), env: c.env.APP_ENV }, h`<div class="panel"><h1>Not found</h1><a class="btn" href="/">Back to overview</a></div>`), 404));

export default { fetch: app.fetch };
