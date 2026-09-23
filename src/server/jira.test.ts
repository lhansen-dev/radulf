import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJiraIssue, jiraCardDraft, parseJiraIssueRef, wikiToMarkdown } from "./jira";

const configured = { jiraBaseUrl: "https://example.atlassian.net/", jiraEmail: "me@example.com", jiraApiToken: "tok" };

describe("parseJiraIssueRef", () => {
  it.each([
    ["DEV-123", "DEV-123"],
    ["dev-123", "DEV-123"],
    ["  DEV-123 ", "DEV-123"],
    ["https://example.atlassian.net/browse/DEV-123", "DEV-123"],
    ["https://example.atlassian.net/browse/DEV-123?focusedCommentId=1", "DEV-123"],
    ["https://example.atlassian.net/jira/software/projects/DEV/boards/3?selectedIssue=DEV-45", "DEV-45"],
    ["https://example.atlassian.net/jira/software/c/projects/DEV/issues/DEV-7", "DEV-7"],
  ])("reads %s as %s", (input, key) => {
    expect(parseJiraIssueRef(input)).toBe(key);
  });

  it.each(["", "not a key", "https://example.atlassian.net/jira/software/projects/DEV/boards/3", "DEV123"])(
    "rejects %s",
    (input) => {
      expect(parseJiraIssueRef(input)).toBeNull();
    },
  );
});

describe("wikiToMarkdown", () => {
  it("converts headings, lists, links, code, quotes, bold and monospace", () => {
    const wiki = [
      "h2. Goal",
      "Make the *widget* faster, see [the doc|https://example.com/doc] and [https://example.com].",
      "# first",
      "# second",
      "## nested",
      "* bullet",
      "** sub bullet",
      "bq. quoted",
      "{code:java}",
      "int x = *not bold*;",
      "{code}",
      "Run {{make check}}.",
    ].join("\n");

    expect(wikiToMarkdown(wiki)).toBe(
      [
        "## Goal",
        "Make the **widget** faster, see [the doc](https://example.com/doc) and https://example.com.",
        "1. first",
        "1. second",
        "   1. nested",
        "- bullet",
        "  - sub bullet",
        "> quoted",
        "```java",
        "int x = *not bold*;",
        "```",
        "Run `make check`.",
      ].join("\n"),
    );
  });

  it("leaves plain prose alone", () => {
    expect(wikiToMarkdown("Just a sentence with snake_case and 2*3.")).toBe("Just a sentence with snake_case and 2*3.");
  });
});

describe("fetchJiraIssue", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches the issue through REST v2 with basic auth and converts wiki markup", async () => {
    const fetchMock = stubFetch(200, {
      key: "DEV-123",
      fields: { summary: "  Fix the widget ", description: "h2. Why\nIt is *slow*." },
    });

    const issue = await fetchJiraIssue("https://example.atlassian.net/browse/DEV-123", configured);

    expect(issue).toEqual({
      key: "DEV-123",
      url: "https://example.atlassian.net/browse/DEV-123",
      summary: "Fix the widget",
      description: "## Why\nIt is **slow**.",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/2/issue/DEV-123?fields=summary,description");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`,
    );
  });

  it("reads an Atlassian Document Format description too", async () => {
    stubFetch(200, {
      key: "DEV-9",
      fields: {
        summary: "ADF",
        description: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "See " },
                { type: "text", text: "the doc", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
              ],
            },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }],
            },
          ],
        },
      },
    });

    const issue = await fetchJiraIssue("DEV-9", configured);

    expect(issue.description).toBe("## Why\n\nSee [the doc](https://example.com)\n\n- one");
  });

  it.each([
    [401, /email or API token/],
    [403, /refused this account access to DEV-1/],
    [404, /DEV-1 was not found/],
    [500, /responded 500/],
  ])("maps a %s response to a message", async (status, message) => {
    stubFetch(status, {});
    await expect(fetchJiraIssue("DEV-1", configured)).rejects.toThrow(message);
  });

  it("tells a rejected token apart from a missing issue, since Jira answers both with 404", async () => {
    // Jira Cloud falls back to anonymous on a bad token: the issue lookup
    // says 404, and only /myself admits the 401.
    const fetchMock = vi.fn(async (url: string) =>
      new Response("{}", { status: url.endsWith("/rest/api/2/myself") ? 401 : 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJiraIssue("DEV-1", configured)).rejects.toThrow(/email or API token/);
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/rest/")[1])).toEqual([
      "api/2/issue/DEV-1?fields=summary,description",
      "api/2/myself",
    ]);
  });

  it("trims a token pasted with whitespace around it", async () => {
    const fetchMock = stubFetch(200, { key: "DEV-1", fields: { summary: "s" } });
    await fetchJiraIssue("DEV-1", { ...configured, jiraApiToken: "  tok\n" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`,
    );
  });

  it("names the site when Jira is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(fetchJiraIssue("DEV-1", configured)).rejects.toThrow(
      /cannot reach Jira at https:\/\/example.atlassian.net: ECONNREFUSED/,
    );
  });

  it("refuses before any request when unconfigured or the reference is not an issue", async () => {
    const fetchMock = stubFetch(200, {});
    await expect(fetchJiraIssue("DEV-1", { ...configured, jiraApiToken: "" })).rejects.toThrow(/not configured/);
    await expect(fetchJiraIssue("nonsense", configured)).rejects.toThrow(/does not look like/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("jiraCardDraft", () => {
  it("puts the key in the title and the link first in the description", () => {
    expect(jiraCardDraft({ key: "DEV-1", url: "https://j/browse/DEV-1", summary: "Fix", description: "Body" })).toEqual({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      title: "[DEV-1] Fix",
      description: "Jira: https://j/browse/DEV-1\n\nBody",
    });
    expect(jiraCardDraft({ key: "DEV-1", url: "https://j/browse/DEV-1", summary: "", description: "" })).toEqual({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      title: "DEV-1",
      description: "Jira: https://j/browse/DEV-1",
    });
  });
});
