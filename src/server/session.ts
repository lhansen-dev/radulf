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
  const secret = getSecret();
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(expiresAtMs)),
  );
  return `${expiresAtMs}.${base64url(sig)}`;
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

  const secret = getSecret();
  const key = await importHmacKey(secret);

  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(expiresAtMs)),
  );

  // Constant-time comparison
  const expectedArr = new Uint8Array(expectedSig);
  const actualArr = base64urlDecode(sigB64);
  if (expectedArr.byteLength !== actualArr.byteLength) return false;

  return constantTimeEqual(expectedArr, actualArr);
}

/**
 * CSRF backstop: returns true for allowed origins.
 *
 * Accepts localhost origins (any scheme/port) and the deployment host named
 * by the RADULF_ALLOWED_ORIGIN env var (a bare hostname).
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // browser won't send Origin for same-origin GET
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
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
  return origin && isAllowedOrigin(origin) ? origin : request.url;
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