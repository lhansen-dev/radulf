// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { renderInlineMarkdown } from "./renderInline";

afterEach(() => {
  cleanup();
});

describe("renderInlineMarkdown", () => {
  it("renders bold with <strong>", () => {
    const { container } = render(<div>{renderInlineMarkdown("hello **bold** world")}</div>);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold");
  });

  it("renders code with <code>", () => {
    const { container } = render(<div>{renderInlineMarkdown("use `code` here")}</div>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("code");
  });

  it("renders italic with <em>", () => {
    const { container } = render(<div>{renderInlineMarkdown("some *italic* text")}</div>);
    const em = container.querySelector("em");
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe("italic");
  });

  it("renders a link with the correct href", () => {
    const { container } = render(<div>{renderInlineMarkdown("click [here](https://example.com) now")}</div>);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://example.com");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noreferrer");
    expect(link!.textContent).toBe("here");
  });

  it("neutralizes javascript: link hrefs to #", () => {
    const { container } = render(
      <div>{renderInlineMarkdown("click [here](javascript:alert(1)) now")}</div>,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("#");
    expect(link!.textContent).toBe("here");
  });

  it("neutralizes data: and vbscript: schemes to #", () => {
    const { container } = render(
      <div>
        {renderInlineMarkdown("[a](data:text/html,<script>1</script>) [b](VBScript:x)")}
      </div>,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("#");
    expect(links[1].getAttribute("href")).toBe("#");
  });

  it("allows mailto: and relative link hrefs", () => {
    const { container } = render(
      <div>{renderInlineMarkdown("[mail](mailto:a@b.com) [rel](/card/1)")}</div>,
    );
    const links = container.querySelectorAll("a");
    expect(links[0].getAttribute("href")).toBe("mailto:a@b.com");
    expect(links[1].getAttribute("href")).toBe("/card/1");
  });

  it("does NOT turn ** inside a code span into bold", () => {
    const { container } = render(<div>{renderInlineMarkdown("use `**not bold**` here")}</div>);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("**not bold**");

    // No <strong> should exist
    const strong = container.querySelector("strong");
    expect(strong).toBeNull();
  });

  it("renders plain text unchanged", () => {
    const { container } = render(<div>{renderInlineMarkdown("just plain text")}</div>);
    expect(container.textContent).toBe("just plain text");
  });

  it("renders mixed bold, italic, code, and link", () => {
    const { container } = render(<div>{renderInlineMarkdown("**bold** *italic* `code` and [link](/)")}</div>);
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("italic");
    expect(container.querySelector("code")!.textContent).toBe("code");
    expect(container.querySelector("a")!.textContent).toBe("link");
  });

  it("handles empty string", () => {
    const { container } = render(<div>{renderInlineMarkdown("")}</div>);
    expect(container.textContent).toBe("");
  });

  it("handles string with no markdown", () => {
    const { container } = render(<div>{renderInlineMarkdown("Hello world 123")}</div>);
    expect(container.textContent).toBe("Hello world 123");
  });

  it("assigns key props to every element", () => {
    const nodes = renderInlineMarkdown("**a** *b* `c`");
    // Every node that is not a string should have a key
    for (const node of nodes) {
      if (React.isValidElement(node)) {
        expect(node.key).not.toBeNull();
      }
    }
  });
});