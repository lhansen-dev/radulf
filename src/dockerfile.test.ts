import fs from "node:fs";
import { describe, expect, it } from "vitest";

// `next start` loads next.config.ts in the runtime image, so everything it
// imports by relative path has to be copied there. A missing one is a
// container that dies at boot with "Cannot find module", and CI never builds
// the image (make check-compose needs Docker).
describe("Dockerfile runtime stage", () => {
  it("copies every file next.config.ts imports by relative path", () => {
    const config = fs.readFileSync("next.config.ts", "utf8");
    const dockerfile = fs.readFileSync("Dockerfile", "utf8");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const imports = [...config.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    const missing = imports.filter((file) => !new RegExp(`COPY[^\\n]*/app/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(runtime));
    expect(missing).toEqual([]);
  });
});
