import { asc } from "drizzle-orm";
import { db, repos } from "@/db";
import { hasCommits, isGitRepo, listBranches, tryGit } from "@/server/git";
import { registerRepo } from "@/server/repos";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(db.select().from(repos).orderBy(asc(repos.createdAt)).all());
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "repo body");
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
    return json(registerRepo(name, path, defaultBranch), 201);
  });
}
