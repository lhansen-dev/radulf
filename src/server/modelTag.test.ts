import { describe, it, expect } from "vitest";
import { modelTag } from "./modelTag";

describe("modelTag", () => {
  describe("anthropic (subscription) provider", () => {
    it("prefixed with claude-subscription/", () => {
      expect(modelTag("anthropic", "opus")).toBe("claude-subscription/opus");
      expect(modelTag("anthropic", "sonnet")).toBe("claude-subscription/sonnet");
      expect(modelTag("anthropic", "haiku")).toBe("claude-subscription/haiku");
    });

    it("returns null when model is null", () => {
      expect(modelTag("anthropic", null)).toBeNull();
    });

    it("returns null when model is empty string", () => {
      expect(modelTag("anthropic", "")).toBeNull();
    });

    it("returns null when model is undefined", () => {
      expect(modelTag("anthropic", undefined)).toBeNull();
    });
  });

  describe("openrouter provider", () => {
    it("returns raw model string unchanged", () => {
      expect(modelTag("openrouter", "x")).toBe("x");
      expect(modelTag("openrouter", "gpt-4")).toBe("gpt-4");
      expect(modelTag("openrouter", null)).toBeNull();
    });
  });

  describe("omlx provider", () => {
    it("returns raw model string unchanged", () => {
      expect(modelTag("omlx", "qwen")).toBe("qwen");
      expect(modelTag("omlx", "llama")).toBe("llama");
      expect(modelTag("omlx", undefined)).toBeNull();
    });
  });
});