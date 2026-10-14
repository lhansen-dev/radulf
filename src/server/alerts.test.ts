import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSettings: () => ({ alertWebhookUrl: "https://hooks.example/abc" }) }));

import { postAlert } from "./alerts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("postAlert", () => {
  it("logs a webhook that answers with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await postAlert({ type: "card.needs_attention", title: "t", message: "m" });

    expect(warn).toHaveBeenCalledWith("alert webhook failed: responded 404");
  });
});
