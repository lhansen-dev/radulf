import { migrationsPending } from "@/db";
import { activeRoles } from "@/server/roles";
import { authEnabled } from "@/server/session";
import { json } from "../_lib";

export async function GET() {
  let restartRequired = false;
  try {
    restartRequired = migrationsPending();
  } catch {
    // stay a liveness check even if the DB or journal is unreadable
  }
  return json({
    ok: true,
    name: "radulf",
    restartRequired,
    roles: [...activeRoles()],
    // Whether there is a session to sign out of: with no password configured
    // the login gate is a no-op, and a Sign out control would only confuse.
    authEnabled: authEnabled(),
  });
}
