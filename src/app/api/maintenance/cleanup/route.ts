import { json, handle } from "../../_lib";
import { pruneRuntimeHistory } from "@/server/retention";
import { ClientError } from "@/server/clientError";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ClientError("cleanup body must be an object");
    }
    const olderThanDays = (body as Record<string, unknown>).olderThanDays;
    return json(pruneRuntimeHistory(Number(olderThanDays)));
  });
}
