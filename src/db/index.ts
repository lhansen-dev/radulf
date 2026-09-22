import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export const DATA_DIR = process.env.RADULF_DATA_DIR
  ? path.resolve(/* turbopackIgnore: true */ process.env.RADULF_DATA_DIR)
  : path.join(process.cwd(), "data");
// Spec 14 L3: worktrees live OUTSIDE data/ (default: a sibling), so the
// sandbox policy is simply "deny data/" with no carve-out, and a stray
// `rm -rf ..` from a worktree cwd is no longer two levels from auth.json.
// Old runs stored absolute worktree paths in the DB and keep resolving.
export const WORKTREES_DIR = process.env.RADULF_WORKTREES_DIR
  ? path.resolve(/* turbopackIgnore: true */ process.env.RADULF_WORKTREES_DIR)
  : path.join(path.dirname(DATA_DIR), "worktrees");
// Spec 14: per-run planner output root — plans/<run-id>/ is the planner's only
// writable path. A sibling of data/ for the same reason as worktrees.
export const PLANS_DIR = process.env.RADULF_PLANS_DIR
  ? path.resolve(/* turbopackIgnore: true */ process.env.RADULF_PLANS_DIR)
  : path.join(path.dirname(DATA_DIR), "plans");
// Spec 21: repositories Radulf clones itself when one is registered by URL. A
// sibling of data/ like the two above, so it sits outside the sandbox's data/
// deny, and on a container install inside the same volume as everything else.
export const CLONES_DIR = path.join(path.dirname(DATA_DIR), "repos");
export const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");

function createDb() {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const sqlite = new Database(path.join(DATA_DIR, "radulf.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

// Survive Next.js dev hot-reload: keep one connection per process. Lazy so
// that merely importing this module (e.g. build-time page-data collection,
// which runs parallel workers) doesn't open the DB or race migrations.
const g = globalThis as unknown as { __radulfDb?: ReturnType<typeof createDb> };
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    const real = (g.__radulfDb ??= createDb());
    const value = real[prop as keyof typeof real];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/**
 * True when drizzle/meta/_journal.json lists a migration newer than the last
 * one the open connection applied. Happens when a self-merged card adds a
 * migration while the dev server is running: hot reload swaps in schema code
 * that queries columns migrate() (which only runs at connection open) never
 * created, and every cards query 500s until the server restarts.
 */
export function migrationsPending(): boolean {
  const journal = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")
  ) as { entries: { when: number }[] };
  const newest = Math.max(0, ...journal.entries.map((e) => e.when));
  const applied = db.get<{ m: number | null }>(
    sql`select max(created_at) as m from __drizzle_migrations`
  );
  return (applied?.m ?? 0) < newest;
}

export * from "./schema";
export const now = () => new Date().toISOString();

/**
 * One JSON-valued row of the settings KV table, which the circuit breaker and
 * the rate-limit readings share with the operator's settings. Null when the
 * key is absent or its value is not JSON.
 */
export function readSettingJson(key: string): unknown {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

/** Write one JSON-valued row of the settings KV table, replacing any existing value. */
export function upsertSettingJson(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db.insert(schema.settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: json } })
    .run();
}
