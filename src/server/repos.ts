import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, repos, now } from "@/db";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";

export type Repo = typeof repos.$inferSelect;

/** Spec 27: a repository's gate command from a request body. Absent or blank
 * means none; anything but a string is a client error. */
export function parseGateCommand(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ClientError("gateCommand must be a string");
  return value.trim() || null;
}

export function getRepo(repoId: string): Repo | undefined {
  return db.select().from(repos).where(eq(repos.id, repoId)).get();
}

/** The repo row, or the 404 the API layer returns verbatim. */
export function requireRepo(repoId: string): Repo {
  const repo = getRepo(repoId);
  if (!repo) throw new ClientError("repo not found", 404);
  return repo;
}

/** Insert the repo row and announce it. Shared by registering an existing
 * checkout (POST /api/repos) and creating a fresh one (POST /api/repos/init). */
export function registerRepo(name: string, path: string, defaultBranch: string, gateCommand: string | null = null) {
  if (db.select().from(repos).where(eq(repos.path, path)).get()) {
    throw new ClientError("repo path already registered");
  }
  const row = db
    .insert(repos)
    .values({ id: nanoid(), name, path, defaultBranch, gateCommand, createdAt: now() })
    .returning()
    .get();
  emitEvent("repo.created", { payload: { repoId: row.id, name } });
  return row;
}
