import { listFolder } from "@/server/folderBrowser";
import { getSettings } from "@/server/settings";
import { json, handle } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * List the directories inside `path`, confined to the configured browsable
 * root. Read-only, directories only, and it discloses nothing above the root.
 * POST /api/repos still validates with git before anything is registered.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const requested = new URL(req.url).searchParams.get("path");
    return json(listFolder(requested, getSettings().folderBrowserRoot));
  });
}
