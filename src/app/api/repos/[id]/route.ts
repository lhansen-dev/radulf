import { eq } from "drizzle-orm";
import { db, repos } from "@/db";
import { hasCommits, isGitRepo, listBranches } from "@/server/git";
import { json, err, handle } from "../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const row = db.select().from(repos).where(eq(repos.id, id)).get();
  return row ? json(row) : err("repo not found", 404);
}

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = await req.json();
    const current = db.select().from(repos).where(eq(repos.id, id)).get();
    if (!current) return err("repo not found", 404);
    const patch: Partial<typeof repos.$inferInsert> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.path === "string" && body.path.trim()) {
      if (!(await isGitRepo(body.path.trim()))) return err(`${body.path} is not a git repository`);
      if (!(await hasCommits(body.path.trim()))) {
        return err(`${body.path} has no commits yet — make an initial commit before adding it`);
      }
      patch.path = body.path.trim();
    }
    if (typeof body.defaultBranch === "string" && body.defaultBranch.trim()) {
      const repoPath = patch.path ?? current.path;
      if (!(await listBranches(repoPath)).includes(body.defaultBranch.trim())) {
        return err("defaultBranch does not exist in the repository");
      }
      patch.defaultBranch = body.defaultBranch.trim();
    }
    if (Object.keys(patch).length === 0) return err("nothing to update");
    const row = db.update(repos).set(patch).where(eq(repos.id, id)).returning().get();
    return row ? json(row) : err("repo not found", 404);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  db.delete(repos).where(eq(repos.id, id)).run();
  return json({ ok: true });
}
