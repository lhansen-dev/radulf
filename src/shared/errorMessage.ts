/** The message of a thrown value, whatever was thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
