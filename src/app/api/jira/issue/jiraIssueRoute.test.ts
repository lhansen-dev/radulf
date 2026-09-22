import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "@/server/clientError";

const mocks = vi.hoisted(() => ({ fetchJiraIssue: vi.fn(), getSettings: vi.fn() }));

vi.mock("@/server/jira", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jira")>()),
  fetchJiraIssue: mocks.fetchJiraIssue,
}));
vi.mock("@/server/settings", () => ({ getSettings: mocks.getSettings }));

const { GET } = await import("./route");

const get = (query: string) => GET(new Request(`http://localhost/api/jira/issue${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockReturnValue({ jiraBaseUrl: "https://j", jiraEmail: "e", jiraApiToken: "t" });
});

describe("GET /api/jira/issue", () => {
  it("requires a reference", async () => {
    const response = await get("");

    expect(response.status).toBe(400);
    expect(mocks.fetchJiraIssue).not.toHaveBeenCalled();
  });

  it("returns the card draft for the issue", async () => {
    mocks.fetchJiraIssue.mockResolvedValue({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      summary: "Fix it",
      description: "Body",
    });

    const response = await get("?ref=DEV-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      key: "DEV-1",
      url: "https://j/browse/DEV-1",
      title: "[DEV-1] Fix it",
      description: "Jira: https://j/browse/DEV-1\n\nBody",
    });
    expect(mocks.fetchJiraIssue).toHaveBeenCalledWith("DEV-1", expect.objectContaining({ jiraBaseUrl: "https://j" }));
  });

  it("passes Jira's refusal through as a client error", async () => {
    mocks.fetchJiraIssue.mockRejectedValue(new ClientError("DEV-1 was not found in Jira, or this account cannot see it"));

    const response = await get("?ref=DEV-1");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not found/);
  });
});
