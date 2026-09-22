/**
 * Edge-safe session helpers (Web Crypto only — no fs, no bcrypt).
 *
 * The HMAC secret is read from process.env.RADULF_AUTH_SECRET at runtime.
 * ensureAuthSecret() (in authSecret.ts, Node-only) populates that env var at
 * boot via instrumentation.ts.
 */

export const SESSION_COOKIE = "radulf_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Whether auth is active — the middleware is a no-op when this is false. */
export function authEnabled(): boolean {
  return !!process.env.RADULF_AUTH_PASSWORD_HASH;
}

/**
 * Sign an expiry timestamp into a session cookie value.
 *
 * Format: `<expiresAtMs>.<base64url(hmac_sha256(expiresAtMs))>`
 */
export async function signSession(expiresAtMs: number): Promise<string> {
  return `${expiresAtMs}.${base64url(await hmac(expiresAtMs))}`;
}

/**
 * Verify a session cookie value. Returns true iff the HMAC is valid and the
 * expiry timestamp is still in the future.
 */
export async function verifySession(value: string): Promise<boolean> {
  const dot = value.indexOf(".");
  if (dot === -1) return false;

  const expiresAtMs = Number(value.slice(0, dot));
  const sigB64 = value.slice(dot + 1);

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  // A cookie whose signature is not valid base64 is an invalid session, not a
  // server error: `atob` throws on a stray character, and this runs inside the
  // proxy on every request, so letting it escape turns any garbage cookie —
  // truncated by a proxy, or simply sent by anyone who can reach the port —
  // into a 500 on every route instead of a redirect to /login. Fail closed.
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(sigB64);
  } catch {
    return false;
  }

  return constantTimeEqual(new Uint8Array(await hmac(expiresAtMs)), signature);
}

/**
 * The host (with port) a request was addressed to: the Host header, or the
 * request URL's when a client sent none. Node's HTTP server always passes the
 * header through; the fallback is for in-process callers, such as tests.
 */
export function requestHost(request: Request): string {
  return request.headers.get("host") ?? new URL(request.url).host;
}

/**
 * CSRF backstop: returns true for allowed origins.
 *
 * Same-origin only: the Origin must name the exact host and port the request
 * arrived at, or the deployment host named by RADULF_ALLOWED_ORIGIN (a bare
 * hostname, for a reverse proxy that rewrites Host). This used to accept any
 * localhost or 127.0.0.1 origin on any port. That is not a boundary: browsers
 * treat every localhost port as ONE site, so SameSite=Lax still attaches the
 * session cookie to a request from a page on localhost:8080, and a text/plain
 * POST from it needs no preflight. Every other local dev server, and every
 * XSS in one, could approve a review or register a repo.
 */
export function isAllowedOrigin(origin: string | null, host: string): boolean {
  if (!origin) return true; // browser won't send Origin for same-origin GET
  try {
    const url = new URL(origin);
    return (
      url.host === host ||
      (!!process.env.RADULF_ALLOWED_ORIGIN &&
        url.hostname === process.env.RADULF_ALLOWED_ORIGIN)
    );
  } catch {
    return false;
  }
}

/**
 * Base URL a Route Handler should build its redirects against.
 *
 * `request.url` in a Route Handler carries the address the server is bound to,
 * not the Host the client asked for. On anything but a localhost-only
 * deployment that sends the browser somewhere it cannot reach: bound to
 * 0.0.0.0 a LAN client is redirected to http://0.0.0.0:3000/, and bound to
 * 127.0.0.1 it is sent to the client's own loopback. The proxy rejects any
 * mutating request whose Origin is not allowed before a handler ever runs, so
 * when a browser sent one it is both present and safe to redirect to. Non-
 * browser clients send none, and fall back to the previous behaviour.
 */
export function redirectBase(request: Request): string {
  const origin = request.headers.get("origin");
  return origin && isAllowedOrigin(origin, requestHost(request)) ? origin : request.url;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSecret(): string {
  const secret = process.env.RADULF_AUTH_SECRET;
  if (!secret) throw new Error("RADULF_AUTH_SECRET is not set");
  return secret;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    enc,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The imported key for the secret it was imported from. Importing once per
 * process rather than once per request (the proxy verifies on every hit)
 * while still following a rotated RADULF_AUTH_SECRET. */
let cachedKey: { secret: string; key: CryptoKey } | undefined;

/** HMAC-SHA256 of the expiry timestamp — what signSession writes and
 * verifySession recomputes. */
async function hmac(expiresAtMs: number): Promise<ArrayBuffer> {
  const secret = getSecret();
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: await importHmacKey(secret) };
  return crypto.subtle.sign("HMAC", cachedKey.key, new TextEncoder().encode(String(expiresAtMs)));
}

/** Base64url-encode an ArrayBuffer (no padding). */
function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Convert to binary string, then btoa
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url-decode (adds padding back). */
function base64urlDecode(s: string): Uint8Array {
  // Restore standard base64
  let base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Constant-time Uint8Array comparison. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}