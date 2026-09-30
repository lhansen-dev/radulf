import { record } from "@/server/requestValidation";
import { createSchedule, listSchedules, type ScheduleInput } from "@/server/schedules";
import { json, handle } from "../_lib";

/** Every schedule (spec 22), each with the next time it will fire. */
export async function GET() {
  return json(listSchedules());
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "schedule body");
    return json(createSchedule(parseScheduleBody(body)), 201);
  });
}

/**
 * Shape-check only: `createSchedule` owns the rules (which kinds exist, what
 * a cron expression may say, which config a kind needs), so a field is
 * rejected here for its type and there for its meaning.
 */
function parseScheduleBody(body: Record<string, unknown>): ScheduleInput {
  return {
    kind: String(body.kind ?? "") as ScheduleInput["kind"],
    repoId: typeof body.repoId === "string" && body.repoId.trim() ? body.repoId.trim() : null,
    cron: String(body.cron ?? ""),
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    config: body.config === undefined ? undefined : record(body.config, "schedule config"),
  };
}
