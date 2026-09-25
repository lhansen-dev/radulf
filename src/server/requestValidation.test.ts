import { describe, expect, it } from "vitest";
import { parseCreateCard, parseUpdateCard } from "./cardValidation";
import { optionalInteger, record, rejectUnknownKeys, requiredInteger } from "./requestValidation";
import { REDACTED, SETTING_DEFAULTS, redactSettings, validateSettingsPatch } from "./settings";
import { testSettings } from "@/testUtils/testSettings";

describe("redactSettings", () => {
  const secrets = ["omlxApiKey", "omlxHeaders", "openrouterApiKey", "braveApiKey", "jiraApiToken"] as const;

  it("replaces every stored provider credential with the redaction marker", () => {
    const redacted = redactSettings(testSettings({
      omlxApiKey: "omlx-secret",
      omlxHeaders: "kong-api-key: header-secret",
      openrouterApiKey: "sk-or-v1-secret",
      braveApiKey: "brave-secret",
      jiraApiToken: "jira-secret",
    }));

    for (const key of secrets) expect(redacted[key]).toBe(REDACTED);
    // Not merely masked in place — no fragment of the real value survives.
    const serialized = JSON.stringify(redacted);
    for (const secret of ["omlx-secret", "header-secret", "sk-or-v1-secret", "brave-secret", "jira-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps unset credentials empty, leaves non-secret settings alone, and never mutates its input", () => {
    const input = testSettings({
      openrouterApiKey: "",
      braveApiKey: "brave-secret",
      omlxBaseUrl: "http://127.0.0.1:9999",
      theme: "nord",
    });
    const redacted = redactSettings(input);
    expect(redacted.openrouterApiKey).toBe("");
    expect(redacted.omlxBaseUrl).toBe("http://127.0.0.1:9999");
    expect(redacted.theme).toBe("nord");
    expect(redacted.sandboxEnabled).toBe(true);
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
  it("defaults auto-mode on and the sandbox to strict isolation (spec 14 — the one escape hatch)", () => {
    expect(SETTING_DEFAULTS.autoMode).toBe(true);
    expect(SETTING_DEFAULTS.sandboxEnabled).toBe(true);
    expect(SETTING_DEFAULTS.sandboxNetworkAllowlist).toBe("");
    // The Go/TLS trustd carve-out is opt-in.
    expect(SETTING_DEFAULTS.sandboxWeakerIsolationForGoTls).toBe(false);
  });

  it("accepts correctly typed bounded settings", () => {
    expect(
      validateSettingsPatch({
        autoMode: false,
        plannerProvider: "chatgpt",
        evaluatorProvider: "openrouter",
        plannerTimeoutMinutes: 45,
        defaultMaxIterations: 100,
        evaluatorTimeoutMinutes: 15,
        stallTimeoutSeconds: 30,
        theme: "nord",
        loopReasoningLevel: "high",
        omlxBaseUrl: "http://127.0.0.1:8000",
        omlxHeaders: "kong-api-key: abc123\n",
        omlxContextWindows: "Qwen/Qwen3-8B: 131072\n",
        plannerPromptTemplate: "Plan {{TITLE}}",
        sandboxEnabled: false,
        sandboxNetworkAllowlist: "docs.example.com\nregistry.example.org",
        sandboxWeakerIsolationForGoTls: true,
      }),
    ).toEqual({
      autoMode: false,
      plannerProvider: "chatgpt",
      evaluatorProvider: "openrouter",
      plannerTimeoutMinutes: 45,
      defaultMaxIterations: 100,
      evaluatorTimeoutMinutes: 15,
      stallTimeoutSeconds: 30,
      theme: "nord",
      loopReasoningLevel: "high",
      omlxBaseUrl: "http://127.0.0.1:8000",
      omlxHeaders: "kong-api-key: abc123\n",
      omlxContextWindows: "Qwen/Qwen3-8B: 131072\n",
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
    [{ plannerTimeoutMinutes: 0 }, /integer between/],
    [{ evaluatorTimeoutMinutes: 10_081 }, /integer between/],
    [{ plannerProvider: "unknown" }, /known provider/],
    [{ theme: "matrix" }, /known theme/],
    [{ evaluatorReasoningLevel: "extreme" }, /evaluatorReasoningLevel must be one of/],
    [{ omlxBaseUrl: "file:///tmp/model" }, /http or https/],
    [{ omlxHeaders: "kong-api-key abc123" }, /omlxHeaders: line 1 must look like "Name: value"/],
    [{ omlxHeaders: 42 }, /omlxHeaders must be a string/],
    [{ omlxContextWindows: "Qwen/Qwen3-8B 131072" }, /omlxContextWindows: line 1 must look like "model-id: tokens"/],
    [{ omlxContextWindows: 131072 }, /omlxContextWindows must be a string/],
    [{ evaluatorPromptTemplate: 42 }, /must be a string/],
    [{ improvePromptTemplate: "x".repeat(100_001) }, /at most 100000 characters/],
    [{ madeUpSetting: true }, /unknown setting/],
  ])("rejects invalid settings %#", (value, expected) => {
    expect(() => validateSettingsPatch(value)).toThrow(expected);
  });
});

describe("request validation primitives", () => {
  it("names the body and the key in its errors", () => {
    expect(() => record([], "cleanup body")).toThrow("cleanup body must be an object");
    expect(record({ a: 1 }, "body")).toEqual({ a: 1 });
    expect(() => rejectUnknownKeys({ x: 1 }, new Set(["a"]))).toThrow("unknown field: x");
    expect(() => rejectUnknownKeys({ x: 1 }, new Set(["a"]), "card field")).toThrow("unknown card field: x");
  });

  it("requires an integer in range, coercing numeric strings", () => {
    expect(requiredInteger("30", "budgetMinutes", 10_080)).toBe(30);
    for (const value of [undefined, null, "", 0, 1.5, 10_081, "x"]) {
      expect(() => requiredInteger(value, "budgetMinutes", 10_080)).toThrow(
        "budgetMinutes must be an integer between 1 and 10080",
      );
    }
    for (const value of [undefined, null, ""]) expect(optionalInteger(value, "f", 10)).toBeNull();
    expect(optionalInteger("7", "f", 10)).toBe(7);
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
      openPr: false,
      grillMe: false,
      scopingAuthorsPlan: false,
      planCritic: undefined,
      criticModel: null,
      baseBranch: "feature/base",
    });
  });

  it.each([
    [{ repoId: "r", title: "T", maxIterations: -1 }, /maxIterations/],
    [{ repoId: "r", title: "T", timeoutMinutes: "Infinity" }, /timeoutMinutes/],
    [{ repoId: "r", title: "T", reviewPlanBeforeImplementation: "true" }, /boolean/],
    [{ repoId: "r", title: "T", autoApprove: "yes" }, /autoApprove/],
    [{ repoId: "r", title: "T", openPr: "yes" }, /openPr/],
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

describe("jiraBaseUrl", () => {
  it("accepts blank (import disabled) and a site URL, and rejects anything else", () => {
    expect(validateSettingsPatch({ jiraBaseUrl: "" })).toEqual({ jiraBaseUrl: "" });
    expect(validateSettingsPatch({ jiraBaseUrl: "https://example.atlassian.net" })).toEqual({
      jiraBaseUrl: "https://example.atlassian.net",
    });
    expect(() => validateSettingsPatch({ jiraBaseUrl: "example.atlassian.net" })).toThrow(/must be a URL/);
    expect(() => validateSettingsPatch({ jiraBaseUrl: "ftp://example.atlassian.net" })).toThrow(/http or https/);
  });
});
