import { eq } from "drizzle-orm";
import { db, repos } from "@/db";
import { hasRemote } from "@/server/git";
import { githubStatus } from "@/server/github";
import { json, handle } from "../../_lib";

export const dynamic = "force-dynamic";

/**
 * Spec 15: can this workspace (and optionally this repo) deliver a pull
 * request right now? The two `gh` failures are reported separately because the
 * operator's next action differs — install a tool, or run a login — and
 * `hasRemote` is per repo because most registered repos are local-only.
 *
 * Read-only, and deliberately so: nothing here can push, open a PR, or change
 * a setting. It exists to gate a checkbox honestly rather than let an operator
 * discover at approval time that delivery was never possible.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const repoId = new URL(req.url).searchParams.get("repoId");
    const gh = await githubStatus();
    let remote: boolean | null = null;
    if (repoId) {
      const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
      remote = repo ? await hasRemote(repo.path) : false;
    }
    return json({
      ok: gh.ok,
      reason: gh.ok ? null : gh.reason,
      detail: gh.ok ? null : gh.detail,
      hasRemote: remote,
    });
  });
}
