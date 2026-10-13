import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config security headers", () => {
  it("never sets Referrer-Policy: no-referrer, which breaks the login form", async () => {
    // Under no-referrer a browser sends `Origin: null` on a native form POST,
    // and the proxy's CSRF check refuses it: every browser login was a 403.
    const rules = await nextConfig.headers!();
    const policy = rules.flatMap((rule) => rule.headers).find((h) => h.key === "Referrer-Policy");
    expect(policy?.value).toBe("same-origin");
  });
});
