import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, repos, now } from "@/db";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";

/** Insert the repo row and announce it. Shared by registering an existing
 * checkout (POST /api/repos) and creating a fresh one (POST /api/repos/init). */
export function registerRepo(name: string, path: string, defaultBranch: string) {
  if (db.select().from(repos).where(eq(repos.path, path)).get()) {
    throw new ClientError("repo path already registered");
  }
  const row = db
    .insert(repos)
    .values({ id: nanoid(), name, path, defaultBranch, createdAt: now() })
    .returning()
    .get();
  emitEvent("repo.created", { payload: { repoId: row.id, name } });
  return row;
}
