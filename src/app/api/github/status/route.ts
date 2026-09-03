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
    const params = new URL(req.url).searchParams;
    const repoId = params.get("repoId");
    // `refresh=1` bypasses the 30s cache: the operator fixes auth in a terminal
    // and comes straight back, and being told "still logged out" for another
    // half a minute would make the indicator look broken.
    const gh = await githubStatus({ refresh: params.get("refresh") === "1" });
    let remote: boolean | null = null;
    if (repoId) {
      const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
      remote = repo ? await hasRemote(repo.path) : false;
    }
    return json({
      ok: gh.ok,
      account: gh.ok ? gh.account ?? null : null,
      reason: gh.ok ? null : gh.reason,
      detail: gh.ok ? null : gh.detail,
      hasRemote: remote,
    });
  });
}
