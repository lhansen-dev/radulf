import { cloneRepository } from "@/server/repoClone";
import { registerRepo } from "@/server/repos";
import { record } from "@/server/requestValidation";
import { json, err, handle } from "../../_lib";

/** Clone a repository from a URL into Radulf's own repos dir and register it (spec 21). */
export async function POST(req: Request) {
  return handle(async () => {
    const values = record(await req.json(), "body");
    const url = typeof values.url === "string" ? values.url.trim() : "";
    const name = typeof values.name === "string" ? values.name.trim() : "";
    if (!url) return err("url is required");
    const cloned = await cloneRepository(url, name);
    return json(registerRepo(cloned.name, cloned.path, cloned.defaultBranch), 201);
  });
}
