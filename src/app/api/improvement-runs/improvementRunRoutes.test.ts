import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "@/server/clientError";

const mocks = vi.hoisted(() => ({
  createImprovementRun: vi.fn(),
  listImprovementRuns: vi.fn(),
  stopImprovementRun: vi.fn(),
}));

vi.mock("@/server/improvementRuns", () => ({
  createImprovementRun: mocks.createImprovementRun,
  listImprovementRuns: mocks.listImprovementRuns,
  stopImprovementRun: mocks.stopImprovementRun,
}));

const { GET, POST } = await import("./route");
const { POST: STOP } = await import("./[id]/stop/route");

function postRequest(body: unknown) {
  return new Request("http://localhost/api/improvement-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { repoId: "repo-1", baseBranch: "main", budgetMinutes: 30 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/improvement-runs", () => {
  it("returns the active/recent runs list", async () => {
    const runs = [{ id: "run-1", status: "running" }];
    mocks.listImprovementRuns.mockReturnValue(runs);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs });
  });
});

describe("POST /api/improvement-runs", () => {
  it("creates a run and returns 202", async () => {
    const row = { id: "run-1", ...validBody, status: "running" };
    mocks.createImprovementRun.mockResolvedValue(row);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(row);
    expect(mocks.createImprovementRun).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "repo-1", baseBranch: "main", budgetMinutes: 30 }),
    );
  });

  it("rejects a missing repoId with a clean 4xx before reaching the service", async () => {
    const response = await POST(postRequest({ baseBranch: "main", budgetMinutes: 30 }));
    expect(response.status).toBe(400);
    expect(mocks.createImprovementRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid budgetMinutes with a clean 4xx", async () => {
    const response = await POST(postRequest({ ...validBody, budgetMinutes: 0 }));
    expect(response.status).toBe(400);
    expect(mocks.createImprovementRun).not.toHaveBeenCalled();
  });

  it("surfaces an active-run-exists ClientError as a clean 4xx", async () => {
    mocks.createImprovementRun.mockRejectedValue(
      new ClientError("an improvement run is already active for this repo"),
    );
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "an improvement run is already active for this repo",
    });
  });
});

describe("POST /api/improvement-runs/[id]/stop", () => {
  it("stops a run", async () => {
    const row = { id: "run-1", status: "stopped" };
    mocks.stopImprovementRun.mockReturnValue(row);
    const response = await STOP(new Request("http://localhost/api/improvement-runs/run-1/stop", { method: "POST" }), {
      params: Promise.resolve({ id: "run-1" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(row);
    expect(mocks.stopImprovementRun).toHaveBeenCalledWith("run-1");
  });

  it("returns 404 for a missing run", async () => {
    mocks.stopImprovementRun.mockImplementation(() => {
      throw new ClientError("improvement run not found", 404);
    });
    const response = await STOP(new Request("http://localhost/api/improvement-runs/missing/stop", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(response.status).toBe(404);
  });
});
