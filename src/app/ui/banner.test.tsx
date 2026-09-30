// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Banner } from "./banner";

afterEach(cleanup);

describe("Banner", () => {
  it.each([
    ["red", "text-red-300", "border-red-800/60"],
    ["amber", "text-amber-300", "border-amber-700/60"],
  ] as const)("renders a %s-toned box with the title as a heading above its children", (tone, titleCls, boxCls) => {
    const { container } = render(<Banner tone={tone} title="Heads up"><p>details</p></Banner>);

    expect(screen.getByRole("heading", { level: 3, name: "Heads up" }).className).toContain(titleCls);
    expect(container.firstElementChild!.className).toContain(boxCls);
    expect(screen.getByText("details")).toBeTruthy();
  });
});
