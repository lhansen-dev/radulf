import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./settingsCrypto";

beforeAll(() => {
  process.env.RADULF_AUTH_SECRET =
    "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips with a random IV, so equal plaintexts encrypt differently", () => {
    const first = encryptSecret("sk-real-value");
    const second = encryptSecret("sk-real-value");
    expect(first.startsWith("enc:v1:")).toBe(true);
    expect(first).not.toContain("sk-real-value");
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe("sk-real-value");
    expect(decryptSecret(second)).toBe("sk-real-value");
  });

  it("leaves an empty string unencrypted and passes legacy plaintext through", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
    expect(decryptSecret("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
  });
});
