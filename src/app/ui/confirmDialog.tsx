"use client";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { DialogShell } from "./taskDialog";

export type ConfirmRequest = {
  /** The question, as the dialog's heading: "Delete this task?" */
  title: string;
  /** What going ahead does, and what it does not. */
  body?: string;
  /** The confirming button: the verb, so "Delete", not "OK". */
  action: string;
  /** A loss — a deletion, a cancelled run — gets the red button. */
  danger?: boolean;
};

/**
 * A themed stand-in for window.confirm. `confirm(request)` resolves true when
 * the operator presses the action button and false on Cancel, Escape or the
 * backdrop. Render `dialog` once in the owning component: it is null until a
 * question is open, and a new question cancels one still waiting.
 *
 * Built on DialogShell, so it is for pages, not for use inside another
 * DialogShell: two shells would each trap focus and answer Escape. A dialog
 * that needs to ask something asks inline, in its own footer.
 */
export function useConfirm(): { confirm: (request: ConfirmRequest) => Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((answer: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmRequest) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest(next);
    });
  }, []);

  const answer = (value: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(value);
  };

  const dialog = request ? (
    <DialogShell
      titleId="confirm-title"
      title={request.title}
      closeLabel="Dismiss"
      onRequestClose={() => answer(false)}
      footer={<>
        <button type="button" onClick={() => answer(false)} className="rounded-lg px-4 text-sm text-foreground/60">Cancel</button>
        <button
          type="button"
          onClick={() => answer(true)}
          className={`rounded-lg px-5 text-sm font-semibold ${request.danger ? "bg-red-700 text-white hover:bg-red-600" : "bg-amber-600 text-on-accent hover:bg-amber-500"}`}
        >
          {request.action}
        </button>
      </>}
    >
      {request.body && <p className="text-sm text-foreground/75">{request.body}</p>}
    </DialogShell>
  ) : null;

  return { confirm, dialog };
}
