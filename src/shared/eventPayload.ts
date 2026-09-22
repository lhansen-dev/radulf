/** An event row's JSON payload as an object; {} when it is missing, corrupt,
 * or not an object, so one bad row never throws in a reader. */
export function parsePayload(payload: string | null | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
