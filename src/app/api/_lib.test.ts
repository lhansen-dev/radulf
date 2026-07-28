import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "@/server/clientError";
import { handle } from "./_lib";

afterEach(() => vi.restoreAllMocks());

describe("API error handling", () => {
  it("returns explicit client errors with their requested status", async () => {
    const response = await handle(() => {
      throw new ClientError("invalid value", 422);
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid value" });
  });

  it("maps malformed JSON syntax to a safe 400", async () => {
    const response = await handle(() => {
      throw new SyntaxError("secret parser details");
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });

  it("logs unexpected errors and conceals their messages", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handle(() => {
      throw new Error("database password leaked here");
    });

    expect(logged).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
