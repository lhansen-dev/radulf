import { NextResponse } from "next/server";
import { ClientError } from "@/server/clientError";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Return expected client errors verbatim; conceal unexpected server errors. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ClientError) return err(error.message, error.status);
    if (error instanceof SyntaxError) return err("invalid JSON body");
    console.error("Unhandled API error", error);
    return err("Internal server error", 500);
  }
}
