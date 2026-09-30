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
  it("opens on summary click, stays open for clicks inside, and closes on Escape or an outside click", async () => {
    const user = userEvent.setup();
    renderFixture();
    const summary = screen.getByLabelText("Test menu");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);

    await user.click(summary);
    expect(details.open).toBe(true);
    await user.click(screen.getByText("Inside button"));
    expect(details.open).toBe(true);
    await user.keyboard("{Escape}");
    expect(details.open).toBe(false);

    await user.click(summary);
    expect(details.open).toBe(true);
    await user.click(screen.getByText("Outside button"));
    expect(details.open).toBe(false);
  });
});
