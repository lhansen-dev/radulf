import { listBranches, git, isRalphBranch, isValidBranchName } from "@/server/git";
import { requireRepo } from "@/server/repos";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const repo = requireRepo(id);
    // Radulf's own branches are never a valid base for a task (see isRalphBranch).
    return json((await listBranches(repo.path)).filter((branch) => !isRalphBranch(branch)));
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const repo = requireRepo(id);

    const values = record(await req.json(), "branch body");
    const name = typeof values.name === "string" ? values.name.trim() : "";
    if (!name) return err("branch name is required", 400);
    if (!(await isValidBranchName(name))) return err("branch name is not a valid Git ref", 400);

    const branches = await listBranches(repo.path);
    if (branches.includes(name)) return err("branch already exists", 400);
    const from = values.from === undefined
      ? repo.defaultBranch
      : typeof values.from === "string"
        ? values.from.trim()
        : "";
    if (!branches.includes(from)) return err("base branch does not exist in the repository", 400);

    await git(repo.path, "branch", "--", name, from);
    return json({ name }, 201);
  });
}
