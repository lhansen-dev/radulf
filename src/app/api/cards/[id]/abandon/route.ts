import { getOrchestrator } from "@/server/orchestrator";
import { json, handle } from "../../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    await getOrchestrator().abandon(id);
    return json({ ok: true });
  });
}
