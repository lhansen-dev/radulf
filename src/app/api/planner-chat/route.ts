import { json, err, handle } from "../_lib";
import { plannerChat } from "@/server/chat";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const body = await req.json();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return err("messages is required");
    }
    return json({ reply: await plannerChat(body.messages) });
  });
}
