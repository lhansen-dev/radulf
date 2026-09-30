import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-rl-ext-");

const { db, settings } = await import("@/db");
const { rateLimitExtension } = await import("./rateLimitExtension");
const { readProviderRateLimit } = await import("../providerRateLimit");

beforeEach(() => {
  db.delete(settings).run();
});

/** Minimal stand-in for the slice of ExtensionAPI the observer touches. */
function fakeApi() {
  const handlers = new Map<string, (event: unknown) => void>();
  const api = {
    on: vi.fn((event: string, handler: (event: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
  };
  return { api, handlers };
}

describe("rateLimitExtension", () => {
  it("subscribes to provider responses and nothing else", () => {
    const { api, handlers } = fakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rateLimitExtension("anthropic").factory(api as any);
    expect(api.on).toHaveBeenCalledTimes(1);
    expect([...handlers.keys()]).toEqual(["after_provider_response"]);
  });

  it("stores the reading for the provider the session was built for", () => {
    const { api, handlers } = fakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rateLimitExtension("anthropic").factory(api as any);
    handlers.get("after_provider_response")!({
      type: "after_provider_response",
      status: 200,
      headers: {
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "anthropic-ratelimit-unified-7d-utilization": "0.8",
      },
    });
    expect(readProviderRateLimit("anthropic")!.status).toBe("warning");
    // The reading is filed under the session's provider, not guessed from the
    // header vendor, so a proxy that forwards Anthropic headers cannot
    // silently overwrite another provider's standing.
    expect(readProviderRateLimit("openrouter")).toBeNull();
  });

  it("is hidden from the startup extension list", () => {
    expect(rateLimitExtension("anthropic").hidden).toBe(true);
  });
});
