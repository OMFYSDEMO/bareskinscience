import type { User } from "../env";
import { newId, newToken, sha256Hex, safeEqual, one, audit } from "../db";

const ITER = 100_000;  // the Workers runtime's PBKDF2 ceiling
const SESSION_DAYS = 14;
export const COOKIE = "bare_ops";

async function pbkdf2(password: string, saltB64: string): Promise<string> {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
export async function hashPassword(password: string) {
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return { pw_salt: salt, pw_hash: await pbkdf2(password, salt) };
}
export function passwordError(pw: string): string | null {
  return pw.length < 10 ? "Use at least 10 characters for the password." : null;
}

export async function createUser(db: D1Database, by: string | null, u: { email: string; name: string; role: "admin" | "staff"; password: string }) {
  const id = newId("usr");
  const h = await hashPassword(u.password);
  await db.batch([
    db.prepare("INSERT INTO users (id, email, name, role, pw_hash, pw_salt) VALUES (?, ?, ?, ?, ?, ?)").bind(id, u.email.trim(), u.name.trim(), u.role, h.pw_hash, h.pw_salt),
    audit(db, by, "create", "user", id, { email: u.email, role: u.role }),
  ]);
  return id;
}

/** Checks a password; five wrong tries lock the account for 15 minutes. Returns a session token or null. */
export async function login(db: D1Database, email: string, password: string): Promise<string | null> {
  const u = await one<{ id: string; pw_hash: string; pw_salt: string; active: number; failed: number; locked_until: string | null }>(
    db, "SELECT id, pw_hash, pw_salt, active, failed, locked_until FROM users WHERE email = ?", email.trim());
  if (!u || !u.active) { await pbkdf2(password, "AAAAAAAAAAAAAAAAAAAAAA=="); return null; }
  if (u.locked_until && u.locked_until > new Date().toISOString()) return null;
  if (!safeEqual(await pbkdf2(password, u.pw_salt), u.pw_hash)) {
    const failed = u.failed + 1;
    const lock = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await db.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failed, lock, u.id).run();
    return null;
  }
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await db.batch([
    db.prepare("UPDATE users SET failed = 0, locked_until = NULL WHERE id = ?").bind(u.id),
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), u.id, expires),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()),
  ]);
  return token;
}

export async function sessionUser(db: D1Database, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return one<User>(db, `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, await sha256Hex(token), new Date().toISOString());
}
export async function logout(db: D1Database, token: string | undefined) {
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}
export async function userCount(db: D1Database) {
  return (await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users"))?.n ?? 0;
}
