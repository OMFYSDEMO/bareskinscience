import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { COOKIE, createUser, login, logout, passwordError, userCount } from "../services/auth";
import { safeEqual } from "../db";
import { layout, h, field } from "./ui";

const app = new Hono<AppEnv>();

const authPage = (c: any, title: string, body: ReturnType<typeof h>, error?: string, status = 200) =>
  c.html(layout({ title, env: c.env.APP_ENV, error }, h`<div class="auth"><img src="/logo-brown.svg" alt="bare Skinscience" width="140" height="64"><div class="panel">${body}</div></div>`), status);

const safeNext = (n: string | undefined) => (n && /^\/[A-Za-z0-9/_\-?=&%.]*$/.test(n) && !n.startsWith("//") ? n : "/");

function startSession(c: any, token: string) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: c.env.APP_ENV !== "development", sameSite: "Strict", path: "/", maxAge: 14 * 86400 });
}

const loginForm = (next: string, email = "") => h`<h1>Sign in</h1><p class="muted">bare Ops · inventory and billing</p>
  <form method="post" action="/login" class="stack"><input type="hidden" name="next" value="${next}">
  ${field("Email", h`<input name="email" type="email" required autocomplete="username" value="${email}" autofocus>`)}
  ${field("Password", h`<input name="password" type="password" required autocomplete="current-password">`)}
  <button>Sign in</button></form>`;

app.get("/login", async (c) => {
  if (!(await userCount(c.env.DB))) return c.redirect("/setup");
  return authPage(c, "Sign in", loginForm(safeNext(c.req.query("next"))));
});
app.post("/login", async (c) => {
  const f = await c.req.formData();
  const email = String(f.get("email") ?? ""), next = safeNext(String(f.get("next") ?? ""));
  const token = await login(c.env.DB, email, String(f.get("password") ?? ""));
  if (!token) return authPage(c, "Sign in", loginForm(next, email), "Email or password is wrong (or the account is locked for 15 minutes after five tries).", 401);
  startSession(c, token);
  return c.redirect(next);
});
app.post("/logout", async (c) => {
  await logout(c.env.DB, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.redirect("/login");
});

// First run only: creates the first admin. Disappears once any user exists.
// In production it also needs the SETUP_KEY secret, so a stranger who finds the address first can't claim it.
// The key is typed into the form (not put in the address), so any characters work: + & # % would be mangled in a URL.
const needsKey = (c: any) => c.env.APP_ENV === "production";
function keyError(c: any, key: string): string | null {
  if (!needsKey(c)) return null;
  const secret = String(c.env.SETUP_KEY ?? "").trim();
  if (!secret) return "The SETUP_KEY secret isn't set on the bare-ops Worker yet (Settings → Variables and Secrets).";
  return safeEqual(key.trim(), secret) ? null : "That setup key doesn't match the SETUP_KEY secret. Check it and try again.";
}
const setupForm = (c: any, v: Record<string, string> = {}) => h`<h1>Set up bare Ops</h1><p class="muted">Create the first admin account. This page closes once it's done.</p>
  <form method="post" action="/setup" class="stack">
  ${needsKey(c) ? field("Setup key", h`<input name="key" type="password" required autocomplete="off" value="${v.key ?? ""}">`, "The value of the SETUP_KEY secret on the bare-ops Worker.") : ""}
  ${field("Your name", h`<input name="name" required value="${v.name ?? ""}">`)}
  ${field("Email", h`<input name="email" type="email" required value="${v.email ?? ""}">`)}
  ${field("Password", h`<input name="password" type="password" required minlength="10" autocomplete="new-password">`, "At least 10 characters.")}
  <button>Create admin</button></form>`;
app.get("/setup", async (c) => {
  if (await userCount(c.env.DB)) return c.redirect("/login");
  return authPage(c, "Set up", setupForm(c, { key: c.req.query("key") ?? "" }));
});
app.post("/setup", async (c) => {
  if (await userCount(c.env.DB)) return c.redirect("/login");
  const f = await c.req.formData();
  const v = { key: String(f.get("key") ?? ""), name: String(f.get("name") ?? "").trim(), email: String(f.get("email") ?? "").trim(), password: String(f.get("password") ?? "") };
  const kErr = keyError(c, v.key);
  if (kErr) return authPage(c, "Set up", setupForm(c, { ...v, key: "" }), kErr, 403);
  const err = !v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? "Enter your name and a valid email." : passwordError(v.password);
  if (err) return authPage(c, "Set up", setupForm(c, v), err, 400);
  await createUser(c.env.DB, null, { name: v.name, email: v.email, password: v.password, role: "admin" });
  const token = await login(c.env.DB, v.email, v.password);
  startSession(c, token!);
  return c.redirect("/settings?ok=welcome");
});

export default app;
