// The app applies its own schema on first use, so a deploy from GitHub needs no separate migration step.
// Applied files are recorded in app_migrations; each file runs as one transaction (D1 batch).
import m0001 from "../migrations/0001_init.sql";

const MIGRATIONS: [string, string][] = [["0001_init.sql", m0001]];

/** Splits a migration file into statements: strips -- comments, splits on semicolons at line ends. */
export function statements(sql: string): string[] {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

let ready: Promise<void> | null = null;
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= migrate(db).catch((e) => { ready = null; throw e; });
  return ready;
}

async function migrate(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))").run();
  const done = new Set((await db.prepare("SELECT name FROM app_migrations").all<{ name: string }>()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare("INSERT INTO app_migrations (name) VALUES (?)").bind(name)]);
    } catch (e) {
      // Another instance may have applied it at the same moment; that's fine if it's now recorded.
      const now = await db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").bind(name).first();
      if (!now) throw e;
    }
  }
}
