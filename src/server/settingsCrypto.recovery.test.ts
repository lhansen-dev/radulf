import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// The variable instrumentation.ts sets at boot is deliberately absent here:
// this is the state a long-running `next dev` ends up in after @next/env
// restores its boot-time snapshot of process.env.
const testDataDir = setupTestDataDir("radulf-crypto-recovery-");
delete process.env.RADULF_AUTH_SECRET;
const secret = "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";
fs.writeFileSync(path.join(testDataDir, "auth-secret"), `${secret}\n`);

const { decryptSecret, encryptSecret } = await import("./settingsCrypto");

afterAll(() => {
  delete process.env.RADULF_AUTH_SECRET;
});

describe("settings crypto without RADULF_AUTH_SECRET in the environment", () => {
  it("reads the auth-secret file instead of failing the save", () => {
    const encrypted = encryptSecret("kong-api-key: secret-value");

    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("kong-api-key: secret-value");
    expect(process.env.RADULF_AUTH_SECRET).toBe(secret);
  });
});
