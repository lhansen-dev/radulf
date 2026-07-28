import { chooseFolder } from "@/server/folderPicker";
import { isGitRepo } from "@/server/git";
import { json, handle } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Open the host's folder chooser and report what was picked. POST /api/repos
 * still re-validates the path — this only lets the UI flag a non-repo folder
 * before the user hits Add.
 */
export async function POST() {
  return handle(async () => {
    const path = await chooseFolder();
    if (path === null) return json({ cancelled: true });
    return json({ path, isGitRepo: await isGitRepo(path) });
  });
}
