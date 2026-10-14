// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DialogShell } from "./taskDialog";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <DialogShell titleId="t" title="Dialog" closeLabel="Close" onRequestClose={() => setOpen(false)} footer={null}>
          <input aria-label="Title" autoFocus />
        </DialogShell>
      )}
    </>
  );
}

describe("DialogShell", () => {
  it("keeps a child's autoFocus, and returns focus to the invoker on close", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    expect(document.activeElement).toBe(screen.getByLabelText("Title"));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
