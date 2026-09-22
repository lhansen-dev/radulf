import { record } from "@/server/requestValidation";
import { deleteSchedule, updateSchedule, type ScheduleInput } from "@/server/schedules";
import { json, handle } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/schedules/:id — change any field, including `enabled`, which is
 * how a cadence is suspended without losing its configuration (spec 22).
 * Every present field is re-validated as a whole, so a cron edit cannot land
 * a kind's config in a shape that kind does not take.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = record(await req.json(), "schedule body");
    const patch: Partial<ScheduleInput> = {};
    if ("kind" in body) patch.kind = String(body.kind) as ScheduleInput["kind"];
    if ("repoId" in body) {
      patch.repoId = typeof body.repoId === "string" && body.repoId.trim() ? body.repoId.trim() : null;
    }
    if ("cron" in body) patch.cron = String(body.cron);
    if ("enabled" in body) patch.enabled = Boolean(body.enabled);
    if ("config" in body) patch.config = record(body.config, "schedule config");
    return json(updateSchedule(id, patch));
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    deleteSchedule(id);
    return json({ ok: true });
  });
}
