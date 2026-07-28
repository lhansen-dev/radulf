import { getOrchestrator } from "@/server/orchestrator";
import { ClientError } from "@/server/clientError";
import type { ApprovedInstallScript } from "@/db";
import { json, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { packages: { name, version, scriptHash }[] } — the install-script
 * gate approval (spec 14). Out-of-band human decision; never model-reachable. */
export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { packages?: unknown }
      | null;
    if (!body || !Array.isArray(body.packages)) {
      throw new ClientError("body must be { packages: [...] }");
    }
    const packages: ApprovedInstallScript[] = body.packages.map((p) => {
      const pkg = p as Record<string, unknown>;
      if (
        typeof pkg?.name !== "string" ||
        typeof pkg?.version !== "string" ||
        typeof pkg?.scriptHash !== "string"
      ) {
        throw new ClientError("each package needs name, version, and scriptHash");
      }
      return { name: pkg.name, version: pkg.version, scriptHash: pkg.scriptHash };
    });
    return json(await getOrchestrator().approveInstallScripts(id, packages));
  });
}
