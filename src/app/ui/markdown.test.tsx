// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headings, lists, and inline marks as elements, never as raw syntax", () => {
    const { container } = render(<Markdown>{"## Changes\n\nRun `npm test` **now**\n\n- a\n- b\n\n1. c"}</Markdown>);

    expect(container.textContent).not.toContain("#");
    expect(container.textContent).not.toContain("*");
    expect(container.querySelector("code")!.textContent).toBe("npm test");
    expect(container.querySelector("strong")!.textContent).toBe("now");
    expect([...container.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(container.querySelector("ol li")!.textContent).toBe("c");
  });

  it("opens links in a new tab and neutralizes unsafe schemes", () => {
    const { container } = render(<Markdown>{"[ok](https://example.com) [bad](javascript:alert(1))"}</Markdown>);

    const [ok, bad] = [...container.querySelectorAll("a")];
    expect(ok.getAttribute("href")).toBe("https://example.com");
    expect(ok.getAttribute("target")).toBe("_blank");
    expect(bad.textContent).toBe("bad");
    expect(bad.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});
