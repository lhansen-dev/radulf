import { record } from "@/server/requestValidation";
import { answerLogin, cancelLogin, readLogin } from "@/server/providerLogin";
import { json, err, handle } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — the login's current state: what pi has said so far and what it is
 * waiting on. Polled rather than pushed over the event bus, which every open
 * tab receives and which must never carry an `auth_url` and its PKCE state
 * (spec 23).
 */
export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    return json(readLogin(id));
  });
}

/**
 * POST — answer the outstanding prompt. `token` names the question, so an
 * answer that arrives after the flow moved on is refused rather than applied
 * to whatever came next.
 */
export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const body = record(await req.json(), "answer body");
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) return err("token is required");
    if (typeof body.value !== "string") return err("value must be a string");
    return json(answerLogin(id, token, body.value));
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    cancelLogin(id);
    return json({ ok: true });
  });
}
