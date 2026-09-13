// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { DoneSummaryView } from "./doneSummaryView";

afterEach(() => {
  cleanup();
});

// Block parsing and inline rendering have their own suites; this covers the
// wiring from parsed blocks to elements.
describe("DoneSummaryView", () => {
  it("renders parsed blocks as real elements inside the labeled summary box", () => {
    const { container } = render(
      <DoneSummaryView done={"# H1\n## H2\n### H3\n#### H4\n\nRun `npm test` **now**\n\n- a\n- b\n\n1. c"} />,
    );

    expect(container.textContent).not.toContain("#");
    for (const level of [1, 2, 3, 4]) {
      expect(container.querySelector(`h${level}`)!.textContent).toBe(`H${level}`);
    }
    expect(container.querySelector("p code")!.textContent).toBe("npm test");
    expect(container.querySelector("p strong")!.textContent).toBe("now");
    expect([...container.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(container.querySelector("ol li")!.textContent).toBe("c");
    expect(container.querySelector("span")!.textContent).toBe("Loop's DONE summary");
  });

  it.each(["", "   \n  \n  "])("renders nothing for blank input %j", (done) => {
    expect(render(<DoneSummaryView done={done} />).container.innerHTML).toBe("");
  });
});
