import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// One mutable settings object behind a mocked `getSettings`, so each test flips
// the two things that gate the comment — the opt-in and the base URL — without
// touching the settings table or the encryption key.
const mocks = vi.hoisted(() => ({
  settings: {
    jiraCommentOnDone: true,
    jiraBaseUrl: "https://example.atlassian.net/",
    jiraEmail: "me@example.com",
    jiraApiToken: "tok",
  },
}));

vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

// Must run before `@/db` loads, so the events rows the announcements write land
// in a temp database instead of the developer's.
setupTestDataDir("radulf-jiraAnnounce-");
const db = (await import("@/db")).db;
const { cards, events, repos } = await import("@/db/schema");
const { announceCardDone, doneCommentBody } = await import("./jiraAnnounce");

const COMMENT_URL = "https://api.atlassian.com/ex/jira/cloud-1/rest/api/2/issue/DEV-7/comment";
const merged = { kind: "merge", baseBranch: "trunk", mergeCommit: "0123456789abcdef0123456789abcdef01234567" } as const;

/** Every `_edge/tenant_info` lookup succeeds with a cloud id, so the comment
 * goes to the gateway like every other Jira call; `comment` decides what the
 * POST itself gets back. */
function stubFetch(comment: () => Response) {
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/_edge/tenant_info")
      ? new Response(JSON.stringify({ cloudId: "cloud-1" }), { headers: { "content-type": "application/json" } })
      : comment(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The single comment the announce posted, parsed back out of the mock: fails
 * the test if it posted twice, which is the whole point of "no retry". */
function postedComment(fetchMock: ReturnType<typeof stubFetch>): string {
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/comment"));
  expect(calls).toHaveLength(1);
  const init = calls[0] as unknown as [string, RequestInit];
  return String(JSON.parse(init[1].body as string).body);
}

/** Every event the announce wrote, whatever its type. A silent path must write
 * none at all — not even a failure note. */
function eventTypes(): string[] {
  return db.select({ type: events.type }).from(events).all().map((row) => row.type);
}

function rowsOfType(type: string): { cardId: string | null; payload: Record<string, unknown> }[] {
  return db
    .select()
    .from(events)
    .where(eq(events.type, type))
    .all()
    .map((row) => ({ cardId: row.cardId, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

function cardRow() {
  return db.select().from(cards).where(eq(cards.id, "card-1")).all();
}

let previousBaseUrl: string | undefined;
let previousTimeout: string | undefined;

beforeEach(() => {
  previousBaseUrl = process.env.RADULF_PUBLIC_BASE_URL;
  previousTimeout = process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS;
  delete process.env.RADULF_PUBLIC_BASE_URL;
  delete process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS;
  db.delete(events).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "r", path: "/tmp/r", createdAt: "2026-01-01T00:00:00.000Z" })
    .run();
  db.insert(cards)
    .values({
      id: "card-1",
      repoId: "repo-1",
      title: "Fix the widget",
      description: "",
      status: "done",
      position: 0,
      jiraKey: "DEV-7",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  mocks.settings.jiraCommentOnDone = true;
  mocks.settings.jiraBaseUrl = "https://example.atlassian.net/";
  mocks.settings.jiraEmail = "me@example.com";
  mocks.settings.jiraApiToken = "tok";
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.RADULF_PUBLIC_BASE_URL;
  else process.env.RADULF_PUBLIC_BASE_URL = previousBaseUrl;
  if (previousTimeout === undefined) delete process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS;
  else process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS = previousTimeout;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("doneCommentBody", () => {
  it("names the branch and the short merge commit", () => {
    process.env.RADULF_PUBLIC_BASE_URL = "http://host:3000/";
    expect(doneCommentBody({ id: "card-1", title: "Fix the widget" }, merged)).toBe(
      'Radulf finished "Fix the widget": merged into trunk at 0123456.\nCard: http://host:3000/card/card-1',
    );
  });

  it("links the pull request, and says so plainly when there is no link to give", () => {
    process.env.RADULF_PUBLIC_BASE_URL = "http://host:3000";
    expect(doneCommentBody({ id: "card-1", title: "T" }, { kind: "pr", prUrl: "https://github.com/o/r/pull/1" })).toBe(
      'Radulf finished "T": opened pull request https://github.com/o/r/pull/1.\nCard: http://host:3000/card/card-1',
    );
    expect(doneCommentBody({ id: "card-1", title: "T" }, { kind: "pr", prUrl: null })).toBe(
      'Radulf finished "T": pushed as a pull request.\nCard: http://host:3000/card/card-1',
    );
  });

  it("reports an epic by its pieces finishing, since there is no diff to cite", () => {
    process.env.RADULF_PUBLIC_BASE_URL = "http://host:3000";
    expect(doneCommentBody({ id: "card-1", title: "Epic" }, { kind: "epic" })).toBe(
      'Radulf finished "Epic": every task in the epic finished.\nCard: http://host:3000/card/card-1',
    );
  });

  it("falls back to the bare card id when the server never learned its own address", () => {
    delete process.env.RADULF_PUBLIC_BASE_URL;
    expect(doneCommentBody({ id: "card-1", title: "T" }, merged)).toBe(
      'Radulf finished "T": merged into trunk at 0123456.\nCard: card-1',
    );
    process.env.RADULF_PUBLIC_BASE_URL = "   ";
    expect(doneCommentBody({ id: "card-1", title: "T" }, merged)).toBe(
      'Radulf finished "T": merged into trunk at 0123456.\nCard: card-1',
    );
  });
});

describe("announceCardDone", () => {
  it("posts one comment to the gateway for the issue key, once, and records it", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await expect(
      announceCardDone(
        { id: "card-1", title: "Fix the widget", jiraKey: "DEV-7" },
        { kind: "merge", baseBranch: "main", mergeCommit: "abc1234567" },
      ),
    ).resolves.toBeUndefined();

    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/comment"));
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(COMMENT_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
    const body = String(JSON.parse(init.body as string).body);
    expect(body).toContain("Fix the widget");
    expect(body).toContain("main");
    expect(body).toContain("abc1234");
    expect(body).toContain("Card: card-1");

    expect(rowsOfType("jira.commented")).toEqual([{ cardId: "card-1", payload: { key: "DEV-7", status: 201 } }]);
    expect(rowsOfType("jira.comment_failed")).toEqual([]);
  });

  it("links the card through the public base URL when the operator set one", async () => {
    process.env.RADULF_PUBLIC_BASE_URL = "https://radulf.example/";
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await announceCardDone(
      { id: "card-1", title: "Fix the widget", jiraKey: "DEV-7" },
      { kind: "merge", baseBranch: "main", mergeCommit: "abc1234567" },
    );

    expect(postedComment(fetchMock)).toContain("Card: https://radulf.example/card/card-1");
  });

  it("links the pull request when the card finished as one", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await announceCardDone(
      { id: "card-1", title: "Fix the widget", jiraKey: "DEV-7" },
      { kind: "pr", prUrl: "https://github.com/o/r/pull/12" },
    );

    expect(postedComment(fetchMock)).toContain("https://github.com/o/r/pull/12");
  });

  it("says nothing at all when the operator has not opted in", async () => {
    mocks.settings.jiraCommentOnDone = false;
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual([]);
  });

  it("says nothing at all when Jira is not configured", async () => {
    mocks.settings.jiraBaseUrl = "  ";
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual([]);
  });

  it("says nothing at all when the card never came from Jira", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await announceCardDone({ id: "card-1", title: "T", jiraKey: null }, merged);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual([]);
  });

  it.each([401, 404])("records a %i refusal instead of throwing, and touches nothing", async (status) => {
    const fetchMock = stubFetch(() => new Response("nope", { status }));
    const before = cardRow();

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged),
    ).resolves.toBeUndefined();

    // One attempt even when Jira clearly dislikes us: a retry on a 5xx would
    // stack identical comments on a human's ticket.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/comment"))).toHaveLength(1);
    expect(cardRow()).toEqual(before);
    expect(rowsOfType("jira.commented")).toEqual([]);
    expect(rowsOfType("jira.comment_failed")).toEqual([
      { cardId: "card-1", payload: { key: "DEV-7", status, reason: `Jira responded ${status}` } },
    ]);
  });

  it("records a network failure instead of throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged),
    ).resolves.toBeUndefined();

    expect(rowsOfType("jira.comment_failed")).toEqual([
      { cardId: "card-1", payload: { key: "DEV-7", reason: "ECONNREFUSED" } },
    ]);
  });

  it("gives up on a hung Jira at the caller's timeout and records that", async () => {
    // The site answers the cloud-id lookup and then never answers the POST, so
    // what the test measures is the announce's own deadline, not restRoot's.
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/_edge/tenant_info")) {
        return Promise.resolve(
          new Response(JSON.stringify({ cloudId: "cloud-1" }), { headers: { "content-type": "application/json" } }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged, { timeoutMs: 20 }),
    ).resolves.toBeUndefined();

    const failed = rowsOfType("jira.comment_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].cardId).toBe("card-1");
    expect(String(failed[0].payload.reason)).not.toBe("");
    expect(rowsOfType("jira.commented")).toEqual([]);
  });

  it("honors RADULF_JIRA_COMMENT_TIMEOUT_MS when no caller timeout is given", async () => {
    process.env.RADULF_JIRA_COMMENT_TIMEOUT_MS = "20";
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/_edge/tenant_info")) {
        return Promise.resolve(
          new Response(JSON.stringify({ cloudId: "cloud-1" }), { headers: { "content-type": "application/json" } }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged),
    ).resolves.toBeUndefined();

    const failed = rowsOfType("jira.comment_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].cardId).toBe("card-1");
    expect(String(failed[0].payload.reason)).not.toBe("");
    expect(rowsOfType("jira.commented")).toEqual([]);
  });

  it("survives an event stream that cannot be written to", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventsModule = await import("./events");
    vi.spyOn(eventsModule, "emitEvent").mockImplementation(() => {
      throw new Error("db closed");
    });
    const fetchMock = stubFetch(() => new Response("{}", { status: 201 }));

    await expect(
      announceCardDone({ id: "card-1", title: "T", jiraKey: "DEV-7" }, merged),
    ).resolves.toBeUndefined();

    // The comment did go out; only the audit trail was lost, and losing it is
    // not allowed to reach the card that was already finished.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/comment"))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("[radulf] jira event failed:", "db closed");
  });
});