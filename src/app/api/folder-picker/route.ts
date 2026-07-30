import { chooseFolder } from "@/server/folderPicker";
import { hasCommits, isGitRepo } from "@/server/git";
import { json, handle } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Open the host's folder chooser and report what was picked. POST /api/repos
 * still re-validates the path — this only lets the UI flag a non-repo folder,
 * or a repo with no commits to branch from, before the user hits Add.
 */
export async function POST() {
  return handle(async () => {
    const path = await chooseFolder();
    if (path === null) return json({ cancelled: true });
    const repo = await isGitRepo(path);
    return json({ path, isGitRepo: repo, hasCommits: repo ? await hasCommits(path) : false });
  });
}
