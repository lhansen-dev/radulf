import { migrationsPending } from "@/db";
import { json } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  let restartRequired = false;
  try {
    restartRequired = migrationsPending();
  } catch {
    // stay a liveness check even if the DB or journal is unreadable
  }
  return json({ ok: true, name: "radulf", restartRequired });
}
