export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function isUniqueViolation(e: unknown): boolean { return String((e as Error)?.message ?? e).includes("UNIQUE constraint failed"); }
export function isCheckViolation(e: unknown): boolean { return String((e as Error)?.message ?? e).includes("CHECK constraint failed"); }

export function audit(db: D1Database, userId: string | null, action: string, entity: string, entityId: string, data?: unknown): D1PreparedStatement {
  return db.prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, data_json) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, action, entity, entityId, data === undefined ? null : JSON.stringify(data));
}

export const all = <T>(db: D1Database, q: string, ...p: unknown[]) => db.prepare(q).bind(...p).all<T>().then((r) => r.results);
export const one = <T>(db: D1Database, q: string, ...p: unknown[]) => db.prepare(q).bind(...p).first<T>();

export type Settings = Record<string, string>;
export async function getSettings(db: D1Database): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
