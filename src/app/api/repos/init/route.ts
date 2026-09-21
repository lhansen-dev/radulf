import { initRepository } from "@/server/repoInit";
import { registerRepo } from "@/server/repos";
import { getSettings } from "@/server/settings";
import { json, err, handle } from "../../_lib";

export const dynamic = "force-dynamic";

/** Create a fresh repository inside the browsable root and register it. */
export async function POST(req: Request) {
  return handle(async () => {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return err("body must be an object");
    }
    const values = body as Record<string, unknown>;
    const name = typeof values.name === "string" ? values.name.trim() : "";
    const parentPath = typeof values.parentPath === "string" ? values.parentPath.trim() : "";
    if (!name) return err("name is required");
    if (!parentPath) return err("parentPath is required");
    const created = await initRepository(parentPath, name, getSettings().folderBrowserRoot);
    return json(registerRepo(name, created.path, created.defaultBranch), 201);
  });
}
