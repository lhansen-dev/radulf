import { asc } from "drizzle-orm";
import { db, repos } from "@/db";
import { assertInsideBrowsableRoot } from "@/server/folderBrowser";
import { assertBranchExists, assertUsableRepo, tryGit } from "@/server/git";
import { registerRepo } from "@/server/repos";
import { record } from "@/server/requestValidation";
import { getSettings } from "@/server/settings";
import { json, err, handle } from "../_lib";

export async function GET() {
  return json(db.select().from(repos).orderBy(asc(repos.createdAt)).all());
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "repo body");
    const requested = String(body.path ?? "").trim();
    const name = String(body.name ?? "").trim();
    if (!name || !requested) return err("name and path are required");
    // Confined exactly as the picker that produced this path is, and as
    // POST /api/repos/init already was. Without it this endpoint took any
    // absolute path on the host: enough to hand a run a worktree of
    // /etc or someone else's home from a request that never touched the
    // browsable root. A URL Radulf clones itself goes through
    // POST /api/repos/clone, which registers its own directory.
    const path = assertInsideBrowsableRoot(requested, getSettings().folderBrowserRoot);
    await assertUsableRepo(path);

    let defaultBranch = String(body.defaultBranch ?? "").trim();
    if (defaultBranch) await assertBranchExists(path, defaultBranch, "defaultBranch");
    if (!defaultBranch) {
      const head = await tryGit(path, "rev-parse", "--abbrev-ref", "HEAD");
      defaultBranch = head.ok && head.out !== "HEAD" ? head.out : "main";
    }
    return json(registerRepo(name, path, defaultBranch), 201);
  });
}
