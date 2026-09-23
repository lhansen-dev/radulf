import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "@/server/clientError";

const mocks = vi.hoisted(() => ({ fetchJiraIssue: vi.fn(), fetchJiraChildren: vi.fn(), getSettings: vi.fn() }));

vi.mock("@/server/jira", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jira")>()),
  fetchJiraIssue: mocks.fetchJiraIssue,
  fetchJiraChildren: mocks.fetchJiraChildren,
}));
vi.mock("@/server/settings", () => ({ getSettings: mocks.getSettings }));

const { GET } = await import("./route");

const get = (query: string) => GET(new Request(`http://localhost/api/jira/issue${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockReturnValue({ jiraBaseUrl: "https://j", jiraEmail: "e", jiraApiToken: "t" });
  mocks.fetchJiraChildren.mockResolvedValue([]);
});

describe("GET /api/jira/issue", () => {
  it("requires a reference", async () => {
    const response = await get("");

    expect(response.status).toBe(400);
    expect(mocks.fetchJiraIssue).not.toHaveBeenCalled();
  });

  it("returns the card draft for the issue, with its child issues drafted the same way", async () => {
    mocks.fetchJiraIssue.mockResolvedValue({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      summary: "Fix it",
      description: "Body",
    });
    mocks.fetchJiraChildren.mockResolvedValue([
      { key: "DEV-2", url: "https://j/browse/DEV-2", summary: "Part one", description: "" },
    ]);

    const response = await get("?ref=DEV-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      title: "[DEV-1] Fix it",
      description: "Jira: https://j/browse/DEV-1\n\nBody",
      children: [
        { key: "DEV-2", url: "https://j/browse/DEV-2", title: "[DEV-2] Part one", description: "Jira: https://j/browse/DEV-2" },
      ],
    });
    expect(mocks.fetchJiraIssue).toHaveBeenCalledWith("DEV-1", expect.objectContaining({ jiraBaseUrl: "https://j" }));
    // Children are listed with the key the issue resolved to, after it was found.
    expect(mocks.fetchJiraChildren).toHaveBeenCalledWith("DEV-1", expect.objectContaining({ jiraBaseUrl: "https://j" }));
  });

  it("passes Jira's refusal through as a client error", async () => {
    mocks.fetchJiraIssue.mockRejectedValue(new ClientError("DEV-1 was not found in Jira, or this account cannot see it"));

    const response = await get("?ref=DEV-1");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not found/);
  });
});
