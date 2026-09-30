import { describe, it, expect } from "vitest";
import { modelTag } from "./modelTag";

describe("modelTag", () => {
  it("prefixes subscription models, passes other providers' models through, and nulls a blank model", () => {
    expect(modelTag("anthropic", "opus")).toBe("claude-subscription/opus");
    expect(modelTag("openrouter", "gpt-4")).toBe("gpt-4");
    expect(modelTag("omlx", "qwen")).toBe("qwen");
    for (const provider of ["anthropic", "openrouter", "omlx"]) {
      for (const model of [null, undefined, ""]) expect(modelTag(provider, model)).toBeNull();
    }
  });
});
