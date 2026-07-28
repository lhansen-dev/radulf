// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { plannerModelTag, PlanModelBadge } from "./planModelBadge";

describe("plannerModelTag", () => {
  it('returns "claude-subscription/opus" for an anthropic plan run', () => {
    const runs = [
      { kind: "plan", provider: "anthropic", model: "opus" },
    ];
    expect(plannerModelTag(runs)).toBe("claude-subscription/opus");
  });

  it("returns the raw model for an openrouter plan run", () => {
    const runs = [
      { kind: "plan", provider: "openrouter", model: "gpt-4" },
    ];
    expect(plannerModelTag(runs)).toBe("gpt-4");
  });

  it("returns null when there is no plan run (only loop runs)", () => {
    const runs = [
      { kind: "loop", provider: "anthropic", model: "sonnet" },
      { kind: "loop", provider: "anthropic", model: "haiku" },
    ];
    expect(plannerModelTag(runs)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(plannerModelTag([])).toBeNull();
  });
});

describe("PlanModelBadge", () => {
  it("renders the tag text when given a tag", () => {
    render(<PlanModelBadge tag="claude-subscription/opus" />);
    expect(screen.getByText(/Planned by/)).toBeTruthy();
    expect(screen.getByText("claude-subscription/opus")).toBeTruthy();
  });

  it("renders nothing (null) when tag is null", () => {
    const { container } = render(<PlanModelBadge tag={null} />);
    expect(container.innerHTML).toBe("");
  });
});