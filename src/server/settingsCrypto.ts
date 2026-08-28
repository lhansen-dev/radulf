/**
 * At-rest encryption for secret settings (provider API keys) stored in the
 * `settings` table. Derives its key from the same root secret
 * `authSecret.ts` generates for session HMAC signing, but through a distinct
 * HKDF `info` string so this use is cryptographically separated from session
 * signing even though it reads the same secret file.
 *
 * Format: `enc:v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`. The prefix lets
 * `decryptSecret` tell an encrypted value apart from a legacy plaintext one
 * written before this module existed — no migration, upgraded opportunistically
 * on next write.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ENC_PREFIX = "enc:v1:";
const HKDF_INFO = "radulf-settings-secret-v1";

// Cheap to derive fresh each call; avoids caching a key that could go stale
// if RADULF_AUTH_SECRET were ever rotated mid-process.
function deriveKey(): Buffer {
  const secret = process.env.RADULF_AUTH_SECRET;
  if (!secret) throw new Error("RADULF_AUTH_SECRET is not set — ensureAuthSecret() must run before settings crypto is used");
  return Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, 32));
}

export function encryptSecret(plaintext: string): string {
  if (plaintext === "") return "";
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (value === "") return "";
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plaintext passthrough
  const [ivB64, authTagB64, ciphertextB64] = value.slice(ENC_PREFIX.length).split(":");
  const key = deriveKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
