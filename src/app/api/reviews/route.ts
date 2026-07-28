import { getOrchestrator } from "@/server/orchestrator";
import { json, err, handle } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const body = await req.json();
    const runId = String(body.runId ?? "");
    const decision = String(body.decision ?? "");
    if (!runId) return err("runId is required");
    const orch = getOrchestrator();

    if (decision === "approved") {
      const result = await orch.approve(runId);
      return result.ok ? json({ ok: true }) : err(result.error ?? "merge failed", 409);
    }
    if (decision === "rejected") {
      orch.reject(runId, String(body.feedback ?? ""));
      return json({ ok: true });
    }
    return err("decision must be 'approved' or 'rejected'");
  });
}
