/**
 * One JSON-over-HTTP helper for the provider integrations.
 *
 * It lives in its own module because two callers need it and they cannot
 * import each other: `providers.ts` imports the harness, so the harness
 * cannot import `providers.ts` back.
 */

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
  let lastError: Error | undefined;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
    } catch (e) {
      lastError = new Error(`cannot reach ${who}: ${e instanceof Error ? e.message : e}`);
      if (attempt >= FETCH_RETRY_DELAYS_MS.length) throw lastError;
      await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (isRetryableStatus(res.status) && attempt < FETCH_RETRY_DELAYS_MS.length) {
        lastError = new Error(`${who} responded ${res.status}: ${body}`);
        await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw new Error(`${who} responded ${res.status}: ${body}`);
    }
    return res.json();
  }
}
