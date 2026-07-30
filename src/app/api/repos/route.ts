import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, repos, now } from "@/db";
import { hasCommits, isGitRepo, listBranches, tryGit } from "@/server/git";
import { emitEvent } from "@/server/events";
import { json, err, handle } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(db.select().from(repos).orderBy(asc(repos.createdAt)).all());
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await req.json();
    const path = String(body.path ?? "").trim();
    const name = String(body.name ?? "").trim();
    if (!name || !path) return err("name and path are required");
    if (!(await isGitRepo(path))) return err(`${path} is not a git repository`);
    // An unborn HEAD has no ref to branch a worktree from — reject here rather
    // than let every task on this repo die at `git worktree add`.
    if (!(await hasCommits(path))) {
      return err(`${path} has no commits yet — make an initial commit before adding it`);
    }

    let defaultBranch = String(body.defaultBranch ?? "").trim();
    if (defaultBranch && !(await listBranches(path)).includes(defaultBranch)) {
      return err("defaultBranch does not exist in the repository");
    }
    if (!defaultBranch) {
      const head = await tryGit(path, "rev-parse", "--abbrev-ref", "HEAD");
      defaultBranch = head.ok && head.out !== "HEAD" ? head.out : "main";
    }
    const existing = db.select().from(repos).where(eq(repos.path, path)).get();
    if (existing) return err("repo path already registered");

    const row = db
      .insert(repos)
      .values({ id: nanoid(), name, path, defaultBranch, createdAt: now() })
      .returning()
      .get();
    emitEvent("repo.created", { payload: { repoId: row.id, name } });
    return json(row, 201);
  });
}
