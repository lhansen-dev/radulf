import { fetchJiraIssue, jiraCardDraft } from "@/server/jira";
import { getSettings } from "@/server/settings";
import { json, err, handle } from "../../_lib";

export const dynamic = "force-dynamic";

/** Fetch one Jira issue and shape it as a card draft for the New Task dialog. */
export async function GET(req: Request) {
  return handle(async () => {
    const ref = new URL(req.url).searchParams.get("ref")?.trim() ?? "";
    if (!ref) return err("ref is required: a Jira issue link or key");
    return json(jiraCardDraft(await fetchJiraIssue(ref, getSettings())));
  });
}
