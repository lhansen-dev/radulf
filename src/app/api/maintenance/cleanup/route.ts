import { json, handle } from "../../_lib";
import { pruneRuntimeHistory } from "@/server/retention";
import { record } from "@/server/requestValidation";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const { olderThanDays } = record(await req.json(), "cleanup body");
    return json(pruneRuntimeHistory(Number(olderThanDays)));
  });
}
