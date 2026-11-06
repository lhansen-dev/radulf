// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useConfirm } from "./confirmDialog";

function Asker({ onAnswer }: { onAnswer: (answer: boolean) => void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        onClick={() => void confirm({ title: "Delete this task?", body: "All its history goes with it.", action: "Delete", danger: true }).then(onAnswer)}
      >
        Delete task
      </button>
      {dialog}
    </>
  );
}

describe("useConfirm", () => {
  afterEach(cleanup);

  it("opens nothing until asked, then resolves with the button pressed", async () => {
    const answers: boolean[] = [];
    render(<Asker onAnswer={(answer) => answers.push(answer)} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByRole("dialog", { name: "Delete this task?" })).toBeTruthy();
    expect(screen.getByText("All its history goes with it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("button", { name: "Delete task" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(answers).toEqual([true]);

    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(answers).toEqual([true, false]));
  });

  it("answers no on Escape", async () => {
    const answers: boolean[] = [];
    render(<Asker onAnswer={(answer) => answers.push(answer)} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(answers).toEqual([false]));
  });
});
