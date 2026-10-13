/**
 * One JSON-over-HTTP helper for the provider integrations.
 *
 * It lives in its own module because two callers need it and they cannot
 * import each other: `providers.ts` imports the harness, so the harness
 * cannot import `providers.ts` back.
 */

import { sleep } from "@/shared/sleep";
import { errorMessage } from "@/shared/errorMessage";

// Transient network hiccups and provider-side overload (5xx/429) are worth a
// short retry; a bad API key or other 4xx would just fail the same way three
// times slower, so those are not retried.
const FETCH_RETRY_DELAYS_MS = [250, 750];

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchJson(
  url: string,
  bearer: string,
  who: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  // Extra headers ride alongside the bearer token. One named Authorization
  // replaces it, so a gateway with its own scheme sees exactly one.
  const hasAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  const requestHeaders = hasAuthorization ? headers : { Authorization: `Bearer ${bearer}`, ...headers };
  for (let attempt = 0; ; attempt++) {
    let err: Error;
    let retryable = true;
    try {
      const res = await fetch(url, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const body = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(body);
        } catch {
          // A 200 that is not JSON is usually a proxy or login page at the wrong URL; retrying won't change it.
          retryable = false;
          err = new Error(`${who} answered with something that is not JSON: ${body.slice(0, 300)}`);
        }
      } else {
        retryable = isRetryableStatus(res.status);
        err = new Error(`${who} responded ${res.status}: ${body.slice(0, 300)}`);
      }
    } catch (e) {
      err = new Error(`cannot reach ${who}: ${errorMessage(e)}`);
    }
    if (retryable && attempt < FETCH_RETRY_DELAYS_MS.length) {
      await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw err;
  }
}
