import { eq } from "drizzle-orm";
import { db, repos } from "@/db";
import { listBranches, git, isValidBranchName } from "@/server/git";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const repo = db.select().from(repos).where(eq(repos.id, id)).get();
  if (!repo) return err("repo not found", 404);
  return json(await listBranches(repo.path));
}

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const repo = db.select().from(repos).where(eq(repos.id, id)).get();
    if (!repo) return err("repo not found", 404);

    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return err("branch body must be an object");
    }
    const values = body as Record<string, unknown>;
    const name = typeof values.name === "string" ? values.name.trim() : "";
    if (!name) return err("branch name is required", 400);
    if (!(await isValidBranchName(name))) return err("branch name is not a valid Git ref", 400);

    const existing = await listBranches(repo.path);
    if (existing.includes(name)) return err("branch already exists", 400);
    const from = values.from === undefined
      ? repo.defaultBranch
      : typeof values.from === "string"
        ? values.from.trim()
        : "";
    if (!from || !existing.includes(from)) return err("base branch does not exist", 400);

    await git(repo.path, "branch", "--", name, from);
    return json({ name }, 201);
  });
}
