import { NextResponse } from "next/server";
import { ClientError } from "@/server/clientError";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * `instanceof` is not sufficient here. The orchestrator singleton is
 * constructed by `instrumentation.ts` at boot, which the dev server loads in a
 * its own module graph — so a `ClientError` thrown through the orchestrator
 * carries a *different* `ClientError` class object than the one this module
 * imported, and `instanceof` reports false. That concealed every expected 400
 * raised through the orchestrator (review decisions, install approvals, card
 * resets) behind an opaque 500; an observed benchmark failed for weeks on
 * `POST /api/reviews` returning "Internal server error" instead of the actual
 * reason. Keep `instanceof` as the fast path and fall back to the brand.
 */
function isClientError(error: unknown): error is ClientError {
  if (error instanceof ClientError) return true;
  return (
    error instanceof Error &&
    error.name === "ClientError" &&
    typeof (error as ClientError).status === "number"
  );
}

/** Return expected client errors verbatim; conceal unexpected server errors. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (isClientError(error)) return err(error.message, error.status);
    if (error instanceof SyntaxError) return err("invalid JSON body");
    console.error("Unhandled API error", error);
    return err("Internal server error", 500);
  }
}
