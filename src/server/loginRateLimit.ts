/**
 * Login brute-force control, in two modes.
 *
 * With RADULF_TRUSTED_PROXY_IP_HEADER set, each client address gets its own
 * bucket and a hard cutoff after MAX_FAILURES — the usual thing.
 *
 * Without it there is no way to tell clients apart, so every direct request
 * shares ONE bucket. A hard cutoff there is an own-goal: anyone who can reach
 * the port could lock the operator out of their own instance with five bad
 * guesses a minute. The shared bucket therefore escalates *delay* instead of
 * refusing. Guessing stays bounded (each wrong answer costs progressively
 * more, capped), while the operator with the right password always gets in —
 * they just wait. Callers pick the mode via `usesSharedLoginBucket()`.
 */
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const MAX_CLIENTS = 1_024;
/** Baseline delay on any failure — also frustrates response-timing probes. */
export const BASE_FAILURE_DELAY_MS = 1_000;
/** Added per recent failure in the shared bucket, up to the cap. */
const SHARED_DELAY_STEP_MS = 2_000;
const SHARED_DELAY_CAP_MS = 15_000;

type FailureEntry = { timestamps: number[]; touchedAt: number };
const failureMap = new Map<string, FailureEntry>();

function prune(now: number) {
  const cutoff = now - FAILURE_WINDOW_MS;
  for (const [key, entry] of failureMap) {
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp >= cutoff);
    if (entry.timestamps.length === 0) failureMap.delete(key);
  }
}

function ensureCapacity() {
  if (failureMap.size < MAX_CLIENTS) return;
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of failureMap) {
    if (entry.touchedAt < oldestAt) {
      oldestAt = entry.touchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) failureMap.delete(oldestKey);
}

/** Use a proxy-supplied address only when the deployment explicitly names
 * the trusted header. Otherwise all direct requests share a bounded key. */
export function loginClientKey(request: Request): string {
  const trustedHeader = process.env.RADULF_TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase();
  if (!trustedHeader) return "direct-client";
  const value = request.headers.get(trustedHeader)?.split(",")[0]?.trim();
  return value && value.length <= 128 ? value : "unknown-proxy-client";
}

/**
 * True when no trusted proxy header is configured, so every direct client
 * lands in one shared bucket and a hard cutoff would lock out the operator.
 */
export function usesSharedLoginBucket(): boolean {
  return !process.env.RADULF_TRUSTED_PROXY_IP_HEADER?.trim();
}

/**
 * How long to stall a failed attempt. Escalates with recent failures so a
 * guessing run slows to a crawl, capped so a legitimate operator who fat-
 * fingered their password is never locked out — only delayed.
 */
export function loginFailureDelayMs(clientKey: string, now = Date.now()): number {
  prune(now);
  const failures = failureMap.get(clientKey)?.timestamps.length ?? 0;
  return Math.min(
    BASE_FAILURE_DELAY_MS + failures * SHARED_DELAY_STEP_MS,
    SHARED_DELAY_CAP_MS,
  );
}

export function isLoginRateLimited(clientKey: string, now = Date.now()): boolean {
  prune(now);
  return (failureMap.get(clientKey)?.timestamps.length ?? 0) >= MAX_FAILURES;
}

export function recordLoginFailure(clientKey: string, now = Date.now()): void {
  prune(now);
  let entry = failureMap.get(clientKey);
  if (!entry) {
    ensureCapacity();
    entry = { timestamps: [], touchedAt: now };
    failureMap.set(clientKey, entry);
  }
  entry.timestamps.push(now);
  entry.touchedAt = now;
}

export function clearLoginFailures(clientKey: string): void {
  failureMap.delete(clientKey);
}

export function resetLoginRateLimit(): void {
  failureMap.clear();
}
