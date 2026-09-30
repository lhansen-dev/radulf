// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DoneSummaryView } from "./doneSummaryView";

afterEach(cleanup);

// Markdown rendering has its own suite (src/app/ui/markdown.test.tsx); this
// covers the wiring into the labeled summary box.
describe("DoneSummaryView", () => {
  it("renders the summary as Markdown inside the labeled summary box", () => {
    const { container } = render(
      <DoneSummaryView done={"# Changes\n\nRun `npm test` **now**\n\n- a\n- b"} />,
    );

    expect(container.querySelector("span")!.textContent).toBe("Loop's DONE summary");
    expect(container.textContent).not.toContain("#");
    expect(container.querySelector("code")!.textContent).toBe("npm test");
    expect(container.querySelector("strong")!.textContent).toBe("now");
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
  });

  it.each(["", "   \n  \n  "])("renders nothing for blank input %j", (done) => {
    expect(render(<DoneSummaryView done={done} />).container.innerHTML).toBe("");
  });
});
