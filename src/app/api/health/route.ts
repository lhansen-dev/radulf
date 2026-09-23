import { migrationsPending } from "@/db";
import { activeRoles } from "@/server/roles";
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
  });
}
