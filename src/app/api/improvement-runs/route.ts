import { createImprovementRun, listImprovementRuns } from "@/server/improvementRuns";
import { parseCreateImprovementRun } from "@/server/improvementRunValidation";
import { json, handle } from "../_lib";

export const dynamic = "force-dynamic";

/** Active + recent improvement runs, for the board. */
export async function GET() {
  return json({ runs: listImprovementRuns() });
}

export async function POST(req: Request) {
  return handle(async () => {
    const input = parseCreateImprovementRun(await req.json());
    const row = await createImprovementRun(input);
    return json(row, 202);
  });
}
