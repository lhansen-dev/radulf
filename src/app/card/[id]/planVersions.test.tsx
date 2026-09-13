// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanVersions } from "./planVersions";
import type { Plan } from "./useCardDetail";

function plan(version: number, overrides: Partial<Plan> = {}): Plan {
  return {
    id: `p${version}`,
    version,
    planMd: `## Tasks\n- [ ] plan v${version} task`,
    promptMd: "",
    acceptanceCriteria: "",
    feedback: null,
    createdAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(cleanup);

describe("PlanVersions", () => {
  const plans = [plan(2, { feedback: "Handle empty input." }), plan(1)];
  const livePlan = { planMd: "## Tasks\n- [x] live one\n- [ ] live two", done: 1, total: 2 };

  it("shows the latest version's live checklist and progress by default", () => {
    render(<PlanVersions plans={plans} livePlan={livePlan} />);

    expect(screen.getByText(/live one/)).toBeTruthy();
    expect(screen.getByText("1 of 2 tasks done · 1 left")).toBeTruthy();
    expect(screen.getByText("Handle empty input.")).toBeTruthy();
    expect(screen.queryByText(/plan v2 task/)).toBeNull();
  });

  it("switches to an earlier version's own PLAN.md", () => {
    render(<PlanVersions plans={plans} livePlan={livePlan} />);

    fireEvent.click(screen.getByRole("button", { name: "v1" }));

    expect(screen.getByText(/plan v1 task/)).toBeTruthy();
    expect(screen.queryByText(/live one/)).toBeNull();
    expect(screen.queryByText(/tasks done/)).toBeNull();
    expect(screen.queryByText("Handle empty input.")).toBeNull();
    expect(screen.getByRole("button", { name: "v1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("falls back to the plan row when there is no live checklist", () => {
    render(<PlanVersions plans={[plan(1)]} livePlan={null} />);

    expect(screen.getByText(/plan v1 task/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "v1" })).toBeNull();
  });
});
