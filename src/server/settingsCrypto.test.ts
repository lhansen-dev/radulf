import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./settingsCrypto";

beforeAll(() => {
  process.env.RADULF_AUTH_SECRET =
    "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptSecret("sk-real-value");
    expect(ciphertext).not.toBe("sk-real-value");
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(ciphertext)).toBe("sk-real-value");
  });

  it("passes a legacy plaintext value through decryptSecret unchanged", () => {
    expect(decryptSecret("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
  });

  it("round-trips an empty string without encrypting it", () => {
    const ciphertext = encryptSecret("");
    expect(ciphertext).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  it("uses a random IV per call, so two encryptions of the same plaintext differ", () => {
    const first = encryptSecret("sk-same-value");
    const second = encryptSecret("sk-same-value");
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe("sk-same-value");
    expect(decryptSecret(second)).toBe("sk-same-value");
  });
});
