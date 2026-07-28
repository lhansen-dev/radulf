import { getOrchestrator } from "@/server/orchestrator";
import { json, err, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const result = await getOrchestrator().retryMerge(id);
    return result.ok ? json({ ok: true }) : err(result.error ?? "merge failed", 409);
  });
}
