import { describe, expect, it } from "vitest";
import { config } from "./proxy";

/** The matcher as the anchored regular expression Next compiles it to. */
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe("proxy matcher", () => {
  it("exempts only Next's static chunks and the favicon", () => {
    for (const p of ["/_next/static/chunks/main.js", "/favicon.ico"]) {
      expect(matcher.test(p)).toBe(false);
    }
  });

  it("covers every route whatever its path ends in, the image optimizer included", () => {
    for (const p of [
      "/",
      "/login",
      "/api/settings",
      "/api/cards/abc/approve-plan.png",
      "/docs/security.svg",
      "/_next/image",
      "/favicon.ico.png",
    ]) {
      expect(matcher.test(p)).toBe(true);
    }
  });
});
