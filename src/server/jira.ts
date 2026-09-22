import { ClientError } from "./clientError";
import type { Settings } from "./settings";
import { errorMessage } from "@/shared/errorMessage";

/**
 * Read-only Jira access for the New Task dialog: fetch one issue and shape it
 * as a card draft. Radulf never writes to Jira. Runs host-side, like the
 * GitHub delivery in github.ts, so the sandboxed agents never hold the token.
 */

export type JiraIssue = { key: string; url: string; summary: string; description: string };
export type JiraCardDraft = { key: string; url: string; title: string; description: string };
type JiraSettings = Pick<Settings, "jiraBaseUrl" | "jiraEmail" | "jiraApiToken">;

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

/** The issue key in a bare key or a pasted link, upper-cased, or null. Covers
 * `/browse/KEY`, a board's `?selectedIssue=KEY`, and any path segment that is
 * a key (`/jira/software/c/projects/DEV/issues/DEV-12`). */
export function parseJiraIssueRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (ISSUE_KEY.test(trimmed)) return trimmed.toUpperCase();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const selected = url.searchParams.get("selectedIssue");
  if (selected && ISSUE_KEY.test(selected)) return selected.toUpperCase();
  const browse = url.pathname.match(/\/browse\/([^/]+)/);
  if (browse && ISSUE_KEY.test(browse[1])) return browse[1].toUpperCase();
  const segment = url.pathname.split("/").reverse().find((part) => ISSUE_KEY.test(part));
  return segment ? segment.toUpperCase() : null;
}

function jiraConfigured(s: JiraSettings): boolean {
  return Boolean(s.jiraBaseUrl.trim() && s.jiraEmail.trim() && s.jiraApiToken);
}

export async function fetchJiraIssue(ref: string, s: JiraSettings): Promise<JiraIssue> {
  if (!jiraConfigured(s)) {
    throw new ClientError("Jira is not configured: add the base URL, account email and API token in Settings");
  }
  const key = parseJiraIssueRef(ref);
  if (!key) throw new ClientError("that does not look like a Jira issue link or key");
  const base = s.jiraBaseUrl.trim().replace(/\/+$/, "");
  // REST v2 returns the description as wiki markup text, which reads well in
  // a card; v3 would return Atlassian Document Format. Both are handled below.
  const url = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.jiraEmail.trim()}:${s.jiraApiToken}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new ClientError(`cannot reach Jira at ${base}: ${errorMessage(e)}`);
  }
  if (res.status === 401) throw new ClientError("Jira rejected the account email or API token in Settings");
  if (res.status === 403) throw new ClientError(`Jira refused this account access to ${key}`);
  if (res.status === 404) throw new ClientError(`${key} was not found in Jira, or this account cannot see it`);
  if (!res.ok) throw new ClientError(`Jira responded ${res.status} for ${key}`);
  const body = (await res.json()) as { key?: string; fields?: { summary?: unknown; description?: unknown } };
  const resolvedKey = typeof body.key === "string" && body.key ? body.key : key;
  const summary = typeof body.fields?.summary === "string" ? body.fields.summary.trim() : "";
  return {
    key: resolvedKey,
    url: `${base}/browse/${resolvedKey}`,
    summary,
    description: descriptionToMarkdown(body.fields?.description),
  };
}

/** What the New Task dialog prefills: a title carrying the key, and a
 * description that opens with the link back so the card always points home. */
export function jiraCardDraft(issue: JiraIssue): JiraCardDraft {
  const title = issue.summary ? `[${issue.key}] ${issue.summary}` : issue.key;
  const link = `Jira: ${issue.url}`;
  return {
    key: issue.key,
    url: issue.url,
    title,
    description: issue.description ? `${link}\n\n${issue.description}` : link,
  };
}

function descriptionToMarkdown(value: unknown): string {
  if (typeof value === "string") return wikiToMarkdown(value).trim();
  if (value && typeof value === "object") return adfToMarkdown(value as AdfNode).trim();
  return "";
}

/**
 * Jira wiki markup to Markdown, for the constructs that show up in ordinary
 * issue descriptions: headings, lists, code and quote blocks, links, bold and
 * monospace. Anything else passes through unchanged; a planner reads the rest
 * fine as it is.
 */
export function wikiToMarkdown(text: string): string {
  // {code}, {code:lang}, {code:title=…|…} and {noformat} pair up as fences.
  let open = false;
  const fenced = text.replace(/\r\n?/g, "\n").replace(/\{(?:code(?::([^}]*))?|noformat)\}/g, (_match, spec?: string) => {
    open = !open;
    if (!open) return "\n```\n";
    const lang = spec && /^[A-Za-z0-9+#.-]+$/.test(spec) ? spec : "";
    return `\n\`\`\`${lang}\n`;
  });
  let inFence = false;
  const lines = fenced.split("\n").map((line) => {
    if (line.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : convertWikiLine(line);
  });
  return lines
    .join("\n")
    // The fence markers above arrive on lines of their own; drop the blank
    // lines that splice created around them.
    .replace(/\n+(```[^\n]*)\n+/g, "\n$1\n")
    .replace(/\n{3,}/g, "\n\n");
}

function convertWikiLine(line: string): string {
  let out = line;
  // Numbered lists before headings: Jira writes lists with `#`, which is what
  // a converted heading starts with.
  const numbered = out.match(/^(#+)\s+(.*)$/);
  if (numbered) out = `${"   ".repeat(numbered[1].length - 1)}1. ${numbered[2]}`;
  const bullet = out.match(/^(\*+|-+)\s+(.*)$/);
  if (bullet) out = `${"  ".repeat(bullet[1].length - 1)}- ${bullet[2]}`;
  out = out.replace(/^h([1-6])\.\s+/, (_match, level: string) => `${"#".repeat(Number(level))} `);
  out = out.replace(/^bq\.\s+/, "> ");
  out = out.replace(/\{quote\}/g, "");
  out = out.replace(/\{\{([^}]+)\}\}/g, "`$1`");
  out = out.replace(/\[([^\]|]+)\|([^\]]+)\]/g, "[$1]($2)");
  out = out.replace(/\[((?:https?|mailto):[^\]]+)\]/g, "$1");
  out = out.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,;:!?)])/g, "$1**$2**");
  return out;
}

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: { level?: number; language?: string };
  marks?: { type?: string; attrs?: { href?: string } }[];
};

/** Atlassian Document Format to Markdown, same coverage as the wiki path. */
function adfToMarkdown(node: AdfNode): string {
  const children = (node.content ?? []).map(adfToMarkdown);
  const inner = children.join("");
  switch (node.type) {
    case "text": {
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      const strong = node.marks?.some((mark) => mark.type === "strong");
      const text = strong ? `**${node.text ?? ""}**` : node.text ?? "";
      return href ? `[${text}](${href})` : text;
    }
    case "hardBreak":
      return "\n";
    case "paragraph":
      return `${inner}\n\n`;
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 1)} ${inner}\n\n`;
    case "bulletList":
      return `${children.map((item) => `- ${item.trim().replace(/\n+/g, "\n  ")}`).join("\n")}\n\n`;
    case "orderedList":
      return `${children.map((item, i) => `${i + 1}. ${item.trim().replace(/\n+/g, "\n   ")}`).join("\n")}\n\n`;
    case "codeBlock":
      return `\`\`\`${node.attrs?.language ?? ""}\n${inner}\n\`\`\`\n\n`;
    case "blockquote":
      return `${inner.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "rule":
      return "---\n\n";
    default:
      return inner;
  }
}
