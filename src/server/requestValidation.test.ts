import { describe, expect, it } from "vitest";
import { parseCreateCard, parseUpdateCard } from "./cardValidation";
import { REDACTED, SETTING_DEFAULTS, redactSettings, validateSettingsPatch } from "./settings";

describe("redactSettings", () => {
  const secrets = ["omlxApiKey", "openrouterApiKey", "braveApiKey"] as const;

  it("replaces every stored provider credential with the redaction marker", () => {
    const redacted = redactSettings({
      ...SETTING_DEFAULTS,
      omlxApiKey: "omlx-secret",
      openrouterApiKey: "sk-or-v1-secret",
      braveApiKey: "brave-secret",
    });

    for (const key of secrets) expect(redacted[key]).toBe(REDACTED);
    // Not merely masked in place — no fragment of the real value survives.
    const serialized = JSON.stringify(redacted);
    for (const secret of ["omlx-secret", "sk-or-v1-secret", "brave-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("distinguishes an unset credential from a set one", () => {
    const redacted = redactSettings({ ...SETTING_DEFAULTS, openrouterApiKey: "" });
    expect(redacted.openrouterApiKey).toBe("");
    expect(redacted.braveApiKey).toBe("");
  });

  it("leaves non-secret settings untouched", () => {
    const input = { ...SETTING_DEFAULTS, omlxBaseUrl: "http://127.0.0.1:9999", theme: "nord" };
    const redacted = redactSettings(input);
    expect(redacted.omlxBaseUrl).toBe("http://127.0.0.1:9999");
    expect(redacted.theme).toBe("nord");
    expect(redacted.sandboxEnabled).toBe(true);
  });

  it("does not mutate its input", () => {
    const input = { ...SETTING_DEFAULTS, braveApiKey: "brave-secret" };
    redactSettings(input);
    expect(input.braveApiKey).toBe("brave-secret");
  });

  it("accepts the marker back as a patch, so the form can round-trip", () => {
    // patchSettings skips secrets whose incoming value is REDACTED; validation
    // has to let it through first for that skip to ever be reached.
    for (const key of secrets) {
      expect(validateSettingsPatch({ [key]: REDACTED })).toEqual({ [key]: REDACTED });
    }
    // Clearing a credential is still expressible.
    expect(validateSettingsPatch({ braveApiKey: "" })).toEqual({ braveApiKey: "" });
  });
});

describe("validateSettingsPatch", () => {
  it("enables auto-mode by default", () => {
    expect(SETTING_DEFAULTS.autoMode).toBe(true);
  });

  it("defaults the sandbox on (spec 14 — the one escape hatch)", () => {
    expect(SETTING_DEFAULTS.sandboxEnabled).toBe(true);
    expect(SETTING_DEFAULTS.sandboxNetworkAllowlist).toBe("");
    // Go/TLS trustd carve-out is opt-in — strict isolation by default.
    expect(SETTING_DEFAULTS.sandboxWeakerIsolationForGoTls).toBe(false);
  });

  it("accepts correctly typed bounded settings", () => {
    expect(
      validateSettingsPatch({
        autoMode: false,
        plannerProvider: "chatgpt",
        evaluatorProvider: "openrouter",
        defaultMaxIterations: 100,
        stallTimeoutSeconds: 30,
        theme: "nord",
        loopReasoningLevel: "high",
        omlxBaseUrl: "http://127.0.0.1:8000",
        plannerPromptTemplate: "Plan {{TITLE}}",
        sandboxEnabled: false,
        sandboxNetworkAllowlist: "docs.example.com\nregistry.example.org",
        sandboxWeakerIsolationForGoTls: true,
      }),
    ).toEqual({
      autoMode: false,
      plannerProvider: "chatgpt",
      evaluatorProvider: "openrouter",
      defaultMaxIterations: 100,
      stallTimeoutSeconds: 30,
      theme: "nord",
      loopReasoningLevel: "high",
      omlxBaseUrl: "http://127.0.0.1:8000",
      plannerPromptTemplate: "Plan {{TITLE}}",
      sandboxEnabled: false,
      sandboxNetworkAllowlist: "docs.example.com\nregistry.example.org",
      sandboxWeakerIsolationForGoTls: true,
    });
  });

  it.each([
    [{ autoMode: "false" }, /boolean/],
    [{ sandboxEnabled: "off" }, /boolean/],
    [{ sandboxNetworkAllowlist: 42 }, /must be a string/],
    [{ defaultTimeoutMinutes: -1 }, /integer between/],
    [{ plannerProvider: "unknown" }, /known provider/],
    [{ theme: "matrix" }, /known theme/],
    [{ evaluatorReasoningLevel: "extreme" }, /evaluatorReasoningLevel must be one of/],
    [{ omlxBaseUrl: "file:///tmp/model" }, /http or https/],
    [{ evaluatorPromptTemplate: 42 }, /must be a string/],
    [{ improvePromptTemplate: "x".repeat(100_001) }, /at most 100000 characters/],
    [{ madeUpSetting: true }, /unknown setting/],
  ])("rejects invalid settings %#", (value, expected) => {
    expect(() => validateSettingsPatch(value)).toThrow(expected);
  });
});

describe("card request validation", () => {
  it("normalizes a valid create request", () => {
    expect(
      parseCreateCard({
        repoId: " repo ",
        title: " Task ",
        description: "Definition",
        maxIterations: "25",
        timeoutMinutes: 60,
        plannerModel: "",
        loopModel: " model ",
        evaluatorModel: " judge ",
        reviewPlanBeforeImplementation: true,
        baseBranch: " feature/base ",
      }),
    ).toEqual({
      repoId: "repo",
      title: "Task",
      description: "Definition",
      maxIterations: 25,
      timeoutMinutes: 60,
      plannerModel: null,
      loopModel: "model",
      evaluatorModel: "judge",
      reviewPlanBeforeImplementation: true,
      autoApprove: false,
      baseBranch: "feature/base",
    });
  });

  it.each([
    [{ repoId: "r", title: "T", maxIterations: -1 }, /maxIterations/],
    [{ repoId: "r", title: "T", timeoutMinutes: "Infinity" }, /timeoutMinutes/],
    [{ repoId: "r", title: "T", reviewPlanBeforeImplementation: "true" }, /boolean/],
    [{ repoId: "r", title: "T", autoApprove: "yes" }, /autoApprove/],
    [{ repoId: "r", title: "T", loopModel: 42 }, /loopModel/],
    [{ repoId: "r", title: "T", evaluatorModel: 42 }, /evaluatorModel/],
    [{ repoId: "r", title: "T", surprise: true }, /unknown card field/],
  ])("rejects an invalid create body %#", (value, expected) => {
    expect(() => parseCreateCard(value)).toThrow(expected);
  });

  it("requires finite positions and bounded optional integers on update", () => {
    expect(() => parseUpdateCard({ position: Number.NaN })).toThrow(/finite/);
    expect(() => parseUpdateCard({ maxIterations: 0 })).toThrow(/maxIterations/);
    expect(() => parseUpdateCard({ title: "" })).toThrow(/title/);
    expect(parseUpdateCard({ maxIterations: null, loopModel: null })).toEqual({
      maxIterations: null,
      loopModel: null,
    });
  });
});
