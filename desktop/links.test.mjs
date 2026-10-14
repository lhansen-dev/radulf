import { describe, it, expect } from "vitest";
import { routeUrl } from "./links.mjs";

const origin = "http://127.0.0.1:3000";

describe("routeUrl", () => {
  it("keeps the server's own pages in the window", () => {
    expect(routeUrl("http://127.0.0.1:3000/card/abc?tab=plan", origin)).toBe("app");
    expect(routeUrl("http://127.0.0.1:3000/docs/getting-started#install-and-run", origin)).toBe("app");
  });

  it("sends web and mail links anywhere else to the system browser", () => {
    expect(routeUrl("https://github.com/lhansen-dev/radulf", origin)).toBe("browser");
    expect(routeUrl("mailto:someone@example.com", origin)).toBe("browser");
    // Same host, different origin: another port, or localhost for 127.0.0.1.
    expect(routeUrl("http://127.0.0.1:3001/", origin)).toBe("browser");
    expect(routeUrl("http://localhost:3000/", origin)).toBe("browser");
  });

  it("drops every other scheme instead of letting the OS launch its handler", () => {
    for (const url of [
      "file:///Applications/Calculator.app",
      "smb://attacker.example/share",
      "vscode://file/etc/hosts",
      "javascript:alert(1)",
      "data:text/html,hi",
      "not a url",
    ]) {
      expect(routeUrl(url, origin), url).toBe("deny");
    }
  });
});
