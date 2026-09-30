// Process roles. A Radulf process runs as `web` (UI + API, no agent work),
// `worker` (orchestrator, no port), or both — selected by RADULF_ROLES.

export const ROLES = ["web", "worker"] as const;

export type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Parse a RADULF_ROLES value. Unset or blank means both roles — one process
 * does everything, which is the default and what existing setups rely on.
 */
export function parseRoles(value: string | undefined): Set<Role> {
  const parts = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return new Set(ROLES);
  const roles = new Set<Role>();
  for (const part of parts) {
    if (!isRole(part)) {
      throw new Error(
        `RADULF_ROLES: unknown role "${part}" (expected a comma-separated list of ${ROLES.join(", ")})`,
      );
    }
    roles.add(part);
  }
  return roles;
}

/**
 * Roles of the current process, read fresh on every call. Never cache this at
 * import time: Next dev loads instrumentation and route handlers in separate
 * module graphs, and the worker entry point sets the variable at runtime, so a
 * value captured at import could be stale or belong to the wrong process.
 */
export function activeRoles(): Set<Role> {
  return parseRoles(process.env.RADULF_ROLES);
}

export function hasRole(role: Role): boolean {
  return activeRoles().has(role);
}
