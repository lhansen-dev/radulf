// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BarList } from "./barList";

afterEach(cleanup);

describe("BarList", () => {
  it("says so when there is nothing to chart", () => {
    render(<BarList data={[]} />);
    expect(screen.getByText("Nothing recorded in this range.")).toBeTruthy();
  });
});
