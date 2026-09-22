import { getOrchestrator } from "@/server/orchestrator";
import { ClientError } from "@/server/clientError";
import { record } from "@/server/requestValidation";
import type { ApprovedInstallScript } from "@/db";
import { json, err, handle } from "../../../_lib";

type Ctx = { params: Promise<{ id: string; action: string }> };

/** Body: { packages: { name, version, scriptHash }[] } — the install-script
 * gate approval (spec 14). Out-of-band human decision; never model-reachable. */
async function installPackages(req: Request): Promise<ApprovedInstallScript[]> {
  const body = record(await req.json(), "approve-install body");
  if (!Array.isArray(body.packages)) {
    throw new ClientError("body must be { packages: [...] }");
  }
  return body.packages.map((p) => {
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
}

const ok = { ok: true };

/** POST /api/cards/:id/:action — the card's single-verb state transitions. */
const ACTIONS: Record<string, (id: string, req: Request) => unknown | Promise<unknown>> = {
  abandon: async (id) => (await getOrchestrator().abandon(id), ok),
  "approve-plan": (id) => (getOrchestrator().approvePlan(id), ok),
  "approve-install": async (id, req) =>
    getOrchestrator().approveInstallScripts(id, await installPackages(req)),
  pause: (id) => (getOrchestrator().pauseCard(id), ok),
  reset: async (id) => (await getOrchestrator().resetCard(id), ok),
  restart: (id) => (getOrchestrator().restartCard(id), ok),
  resume: (id) => (getOrchestrator().resumeCard(id), ok),
  "retry-failed-step": (id) => getOrchestrator().retryFailedStep(id),
  "retry-merge": async (id) => {
    const result = await getOrchestrator().retryMerge(id);
    return result.ok ? ok : err(result.error ?? "merge failed", 409);
  },
};

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id, action } = await params;
    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) return err(`unknown card action: ${action}`, 404);
    const result = await run(id, req);
    return result instanceof Response ? result : json(result);
  });
}
