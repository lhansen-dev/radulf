// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { renderInlineMarkdown } from "./renderInline";

afterEach(() => {
  cleanup();
});

const renderInline = (text: string) => render(<div>{renderInlineMarkdown(text)}</div>).container;

describe("renderInlineMarkdown", () => {
  it("renders bold, italic, code, and links, leaving plain text unchanged", () => {
    const container = renderInline("plain **bold** *italic* `code` and [link](https://example.com)");

    expect(container.textContent).toBe("plain bold italic code and link");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("italic");
    expect(container.querySelector("code")!.textContent).toBe("code");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("link");
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("neutralizes dangerous link schemes to # but allows mailto: and relative hrefs", () => {
    const container = renderInline(
      "[a](javascript:alert(1)) [b](data:text/html,<script>1</script>) [c](VBScript:x) [d](mailto:a@b.com) [e](/card/1)",
    );
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "#",
      "#",
      "#",
      "mailto:a@b.com",
      "/card/1",
    ]);
  });

  it("does not parse markdown inside a code span", () => {
    const container = renderInline("use `**not bold**` here");
    expect(container.querySelector("code")!.textContent).toBe("**not bold**");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("assigns a key to every element", () => {
    for (const node of renderInlineMarkdown("**a** *b* `c`")) {
      if (React.isValidElement(node)) expect(node.key).not.toBeNull();
    }
  });
});
