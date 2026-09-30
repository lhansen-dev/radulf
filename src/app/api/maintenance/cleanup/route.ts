import { json, handle } from "../../_lib";
import { pruneRuntimeHistory } from "@/server/retention";
import { record } from "@/server/requestValidation";

export async function POST(req: Request) {
  return handle(async () => {
    const { olderThanDays } = record(await req.json(), "cleanup body");
    return json(await pruneRuntimeHistory(Number(olderThanDays)));
  });
}
