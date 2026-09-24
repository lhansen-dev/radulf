import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const testDataDir = setupTestDataDir("radulf-auth-secret-");
const secretFile = path.join(testDataDir, "auth-secret");

const { ensureAuthSecret } = await import("./authSecret");

afterEach(() => {
  delete process.env.RADULF_AUTH_SECRET;
  fs.rmSync(secretFile, { force: true });
});

const mode = () => fs.statSync(secretFile).mode & 0o777;

describe("ensureAuthSecret", () => {
  it("creates the secret readable only by its owner", () => {
    ensureAuthSecret();

    expect(mode()).toBe(0o600);
    expect(process.env.RADULF_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tightens a secret an earlier version left world-readable", () => {
    fs.writeFileSync(secretFile, "a".repeat(64), { encoding: "utf-8", mode: 0o644 });
    fs.chmodSync(secretFile, 0o644); // defeat a restrictive umask on the line above

    ensureAuthSecret();

    expect(mode()).toBe(0o600);
    expect(process.env.RADULF_AUTH_SECRET).toBe("a".repeat(64));
  });

  it("re-reads the secret another process is writing when the exclusive create collides", () => {
    // An empty file stands in for a process that has created but not yet
    // written the secret; the child fills it in shortly after.
    fs.writeFileSync(secretFile, "");
    spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => require('node:fs').writeFileSync(process.env.SECRET_FILE, 'b'.repeat(64)), 150)",
      ],
      { env: { ...process.env, SECRET_FILE: secretFile }, stdio: "ignore" },
    );

    ensureAuthSecret(); // blocks until the child has written

    expect(process.env.RADULF_AUTH_SECRET).toBe("b".repeat(64));
    expect(mode()).toBe(0o600);
  });

  it("never overwrites an existing secret", () => {
    fs.writeFileSync(secretFile, "a".repeat(64), "utf-8");

    ensureAuthSecret();

    expect(fs.readFileSync(secretFile, "utf-8")).toBe("a".repeat(64));
  });
});
