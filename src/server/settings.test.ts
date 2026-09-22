import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-settings-");
process.env.RADULF_AUTH_SECRET =
  "4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f";

const { db, settings: settingsTable } = await import("@/db");
const { getSettings, patchSettings } = await import("./settings");

afterAll(() => {
  delete process.env.RADULF_AUTH_SECRET;
});

beforeEach(() => {
  db.delete(settingsTable).run();
});

describe("secret settings encryption at rest", () => {
  it("stores an encrypted value, never the plaintext substring, but getSettings decrypts it", () => {
    patchSettings({ openrouterApiKey: "sk-real-value" });

    const row = db
      .select()
      .from(settingsTable)
      .all()
      .find((r) => r.key === "openrouterApiKey");
    expect(row).toBeDefined();
    expect(row!.value).not.toContain("sk-real-value");

    expect(getSettings().openrouterApiKey).toBe("sk-real-value");
  });

  it("validates a stored header list against its plaintext, not its ciphertext", () => {
    // Without decrypt-before-validate the ciphertext fails the Name: value
    // check and the setting silently falls back to blank.
    patchSettings({ omlxHeaders: "kong-api-key: abc123" });
    expect(getSettings().omlxHeaders).toBe("kong-api-key: abc123");
  });
});
