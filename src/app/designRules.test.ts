import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every .tsx under src/app except tests. */
function components(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return components(full);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("DESIGN.md's Legible Muted Rule", () => {
  it("uses text-muted for secondary text, never a foreground alpha that fails WCAG AA", () => {
    // Plain classes only: placeholder:, hover: and friends are other states.
    const dimmed = /(?<![\w:/-])text-foreground\/([1-5]\d|60)\b/g;
    const offenders = components(path.join(process.cwd(), "src", "app")).flatMap((file) =>
      [...fs.readFileSync(file, "utf8").matchAll(dimmed)].map((m) => `${path.relative(process.cwd(), file)}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });
});
