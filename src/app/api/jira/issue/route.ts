import { fetchJiraChildren, fetchJiraIssue, jiraCardDraft } from "@/server/jira";
import { getSettings } from "@/server/settings";
import { json, err, handle } from "../../_lib";

/** Fetch one Jira issue and shape it as a card draft for the New Task dialog,
 * with its child issues shaped the same way as the pieces of an epic (spec 24). */
export async function GET(req: Request) {
  return handle(async () => {
    const ref = new URL(req.url).searchParams.get("ref")?.trim() ?? "";
    if (!ref) return err("ref is required: a Jira issue link or key");
    const settings = getSettings();
    const issue = await fetchJiraIssue(ref, settings);
    const children = await fetchJiraChildren(issue.key, settings);
    return json({ ...jiraCardDraft(issue), children: children.map(jiraCardDraft) });
  });
}
