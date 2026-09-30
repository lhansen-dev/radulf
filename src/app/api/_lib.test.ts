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

  it("honors a ClientError from another module instance of the class", async () => {
    // What the orchestrator singleton throws: same shape, different class
    // object, so `instanceof` is false. Concealing this behind a 500 is what
    // made POST /api/reviews unreadable.
    class ForeignClientError extends Error {
      constructor(
        message: string,
        readonly status = 400,
      ) {
        super(message);
        this.name = "ClientError";
      }
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handle(() => {
      throw new ForeignClientError("reviews require a completed loop run");
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "reviews require a completed loop run" });
    expect(logged).not.toHaveBeenCalled();
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
