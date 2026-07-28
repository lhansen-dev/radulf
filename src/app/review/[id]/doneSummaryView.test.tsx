// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { DoneSummaryView } from "./doneSummaryView";

afterEach(() => {
  cleanup();
});

describe("DoneSummaryView", () => {
  it("renders a heading as an <h2> (no literal ##)", () => {
    const { container } = render(<DoneSummaryView done="## Summary" />);
    const h2 = container.querySelector("h2");
    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe("Summary");
    // Ensure no literal "##" appears
    expect(container.textContent).not.toContain("##");
  });

  it("renders bold as <strong>", () => {
    const { container } = render(<DoneSummaryView done="This is **important** text" />);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("important");
  });

  it("renders a bullet list as <ul><li>", () => {
    const { container } = render(<DoneSummaryView done={"- Item one\n- Item two"} />);
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    const lis = container.querySelectorAll("li");
    expect(lis.length).toBe(2);
    expect(lis[0].textContent).toBe("Item one");
    expect(lis[1].textContent).toBe("Item two");
  });

  it("returns null for empty input", () => {
    const { container } = render(<DoneSummaryView done="" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for whitespace-only input", () => {
    const { container } = render(<DoneSummaryView done={"   \n  \n  "} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the violet summary box with label", () => {
    const { container } = render(<DoneSummaryView done="Hello" />);
    const outerDiv = container.firstChild as HTMLElement;
    expect(outerDiv.className).toContain("bg-violet-950/40");
    expect(outerDiv.className).toContain("border-violet-800/50");
    const label = outerDiv.querySelector("span");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Loop's DONE summary");
  });

  it("renders an ordered list as <ol><li>", () => {
    const { container } = render(<DoneSummaryView done={"1. First\n2. Second\n3. Third"} />);
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    const lis = container.querySelectorAll("li");
    expect(lis.length).toBe(3);
    expect(lis[0].textContent).toBe("First");
    expect(lis[2].textContent).toBe("Third");
  });

  it("renders mixed content: heading, paragraph, and list", () => {
    const { container } = render(
      <DoneSummaryView done={"# Changes\n\nFixed the bug\n\n- Updated tests\n- Refactored code"} />,
    );
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("p")).not.toBeNull();
    expect(container.querySelector("ul")).not.toBeNull();
  });

  it("renders inline code with <code>", () => {
    const { container } = render(<DoneSummaryView done="Run `npm test` to verify" />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("npm test");
  });

  it("renders heading levels 1-4 correctly", () => {
    const { container } = render(
      <DoneSummaryView done={"# H1\n## H2\n### H3\n#### H4"} />,
    );
    expect(container.querySelector("h1")!.textContent).toBe("H1");
    expect(container.querySelector("h2")!.textContent).toBe("H2");
    expect(container.querySelector("h3")!.textContent).toBe("H3");
    expect(container.querySelector("h4")!.textContent).toBe("H4");
  });
});