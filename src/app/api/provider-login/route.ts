import { record } from "@/server/requestValidation";
import { listLoggableProviders, logoutProvider, startLogin } from "@/server/providerLogin";
import { json, err, handle } from "../_lib";

/** Every provider with an interactive login, and whether it is connected (spec 23). */
export async function GET() {
  return handle(async () => json(await listLoggableProviders()));
}

/**
 * POST /api/provider-login — start a login, or log a provider out.
 *
 * Body: `{ providerId, type: "oauth" | "api_key" }` to start, or
 * `{ providerId, logout: true }`. Starting returns the session's first view;
 * the browser then reads and answers it under /api/provider-login/:id.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "login body");
    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    if (!providerId) return err("providerId is required");
    if (body.logout === true) {
      await logoutProvider(providerId);
      return json({ ok: true });
    }
    if (body.type !== "oauth" && body.type !== "api_key") {
      return err('type must be "oauth" or "api_key"');
    }
    return json(await startLogin(providerId, body.type), 201);
  });
}
