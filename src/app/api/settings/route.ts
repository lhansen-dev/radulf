import { getSettings, patchSettings, redactSettings } from "@/server/settings";
import { getOrchestrator } from "@/server/orchestrator";
import { json, handle } from "../_lib";

export const dynamic = "force-dynamic";

// Both handlers return the REDACTED view: provider API keys never cross the
// wire, in either direction, once they are stored. Server-side callers use
// getSettings() directly and still see the real values.

export async function GET() {
  return json(redactSettings(getSettings()));
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const body: unknown = await req.json();
    patchSettings(body);
    getOrchestrator().pump();
    return json(redactSettings(getSettings()));
  });
}
