import { asc } from "drizzle-orm";
import { db, repos } from "@/db";
import { assertBranchExists, assertUsableRepo, tryGit } from "@/server/git";
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
