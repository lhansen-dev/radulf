// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { plannerModelTag, PlanModelBadge } from "./planModelBadge";

describe("plannerModelTag", () => {
  it("tags the plan run's model, or returns null without one", () => {
    expect(plannerModelTag([{ kind: "plan", provider: "anthropic", model: "opus" }])).toBe(
      "claude-subscription/opus",
    );
    expect(plannerModelTag([{ kind: "loop", provider: "anthropic", model: "sonnet" }])).toBeNull();
    expect(plannerModelTag([])).toBeNull();
  });
});

describe("PlanModelBadge", () => {
  it("renders the tag, or nothing without one", () => {
    const { container, rerender } = render(<PlanModelBadge tag="claude-subscription/opus" />);
    expect(screen.getByText(/Planned by/)).toBeTruthy();
    expect(screen.getByText("claude-subscription/opus")).toBeTruthy();
    rerender(<PlanModelBadge tag={null} />);
    expect(container.innerHTML).toBe("");
  });
});
