// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailsMenu } from "./detailsMenu";

afterEach(() => {
  cleanup();
});

/**
 * Helper that renders a DetailsMenu with a button inside the menu
 * and a button outside the menu (so we can click both).
 */
function renderFixture() {
  render(
    <div>
      <DetailsMenu
        detailsClassName="relative"
        summaryClassName="summary-cls"
        menuClassName="menu-cls"
        ariaLabel="Test menu"
        summary="•••"
      >
        <button type="button" id="inside-btn">
          Inside button
        </button>
      </DetailsMenu>
      <button type="button" id="outside-btn">
        Outside button
      </button>
    </div>
  );
}

describe("DetailsMenu", () => {
  it("opens on summary click then closes on a click outside", async () => {
    const user = userEvent.setup();
    renderFixture();

    // Find the summary (the "•••" button)
    const summary = screen.getByLabelText("Test menu");

    // Details should start closed
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);

    // Click the summary to open
    await user.click(summary);
    expect(details.open).toBe(true);

    // Click the outside button
    const outsideBtn = screen.getByText("Outside button");
    await user.click(outsideBtn);

    // Details should now be closed
    expect(details.open).toBe(false);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderFixture();

    const summary = screen.getByLabelText("Test menu");
    const details = summary.closest("details")!;

    // Open the menu
    await user.click(summary);
    expect(details.open).toBe(true);

    // Press Escape
    await user.keyboard("{Escape}");

    // Details should close
    expect(details.open).toBe(false);
  });

  it("stays open when clicking a button inside the menu", async () => {
    const user = userEvent.setup();
    renderFixture();

    const summary = screen.getByLabelText("Test menu");
    const details = summary.closest("details")!;

    // Open the menu
    await user.click(summary);
    expect(details.open).toBe(true);

    // Click the button inside the menu
    const insideBtn = screen.getByText("Inside button");
    await user.click(insideBtn);

    // Details should remain open
    expect(details.open).toBe(true);
  });
});