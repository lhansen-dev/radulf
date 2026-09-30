import { ClientError } from "./clientError";

/**
 * Primitives for turning an untrusted request body into typed input. Each one
 * throws a `ClientError` (a 400 once it reaches `handle()`) that names the
 * offending field, so the per-endpoint parsers (cardValidation.ts,
 * improvementRunValidation.ts, validateSettingsPatch) only spell out what is
 * specific to their own shape.
 */

export function invalid(message: string): never {
  throw new ClientError(message);
}

/** `what` names the body in the error, e.g. "card body must be an object". */
export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** `what` names the key in the error: "unknown card field: x" vs "unknown field: x". */
export function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>, what = "field") {
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) invalid(`unknown ${what}: ${unknown}`);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} is required`);
  return value.trim();
}

export function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid(`${field} must be a string or null`);
  return value.trim() || null;
}

/** Accepts a number or a numeric string (form inputs post strings) in 1..max. */
export function requiredInteger(value: unknown, field: string, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    invalid(`${field} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function optionalInteger(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredInteger(value, field, max);
}
