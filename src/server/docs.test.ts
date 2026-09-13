import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DOCS,
  DOC_GROUPS,
  getDocMeta,
  listDocs,
  readDoc,
  resolveDocHref,
  stripLayoutHtml,
} from "./docs";

describe("docs registry", () => {
  it("has unique, kebab-case slugs and known source files", async () => {
    const slugs = new Set<string>();
    for (const doc of DOCS) {
      expect(doc.slug).toMatch(/^[a-z0-9-]+$/);
      expect(slugs.has(doc.slug), `duplicate slug ${doc.slug}`).toBe(false);
      slugs.add(doc.slug);
      expect(DOC_GROUPS).toContain(doc.group);
      // Every registered source file must actually exist in the tree.
      const abs = path.join(process.cwd(), doc.sourcePath);
      await expect(readFile(abs, "utf8")).resolves.toBeTypeOf("string");
    }
  });

  it("registers every file physically present under docs/", async () => {
    const dir = path.join(process.cwd(), "docs");
    const entries = await readdir(dir);
    const files = entries.filter((f) => f.endsWith(".md"));
    const registered = new Set(DOCS.map((d) => d.sourcePath));
    for (const file of files) {
      const sourcePath = `docs/${file}`;
      expect(
        registered.has(sourcePath),
        `docs/${file} exists but is not registered in DOCS`,
      ).toBe(true);
    }
  });

  it("readDoc / getDocMeta / listDocs expose the registry, returning nothing for unknown slugs", async () => {
    const doc = await readDoc("how-it-works");
    expect(doc?.meta.slug).toBe("how-it-works");
    expect(doc?.content.length).toBeGreaterThan(0);
    expect(await readDoc("does-not-exist")).toBeNull();
    expect(listDocs()).toBe(DOCS);
    expect(getDocMeta("how-it-works")?.sourcePath).toBe("docs/HOW_IT_WORKS.md");
    expect(getDocMeta("nope")).toBeUndefined();
  });

  it("keeps the wiki curated: no specs and no README in the sidebar", () => {
    // specs/ is a dated decision log with superseded entries — it reaches the
    // UI only through the design-history page. README is the GitHub landing
    // page. Both stay on disk; neither belongs in the nav.
    expect(DOCS.filter((d) => d.sourcePath.startsWith("specs/"))).toEqual([]);
    expect(DOCS.some((d) => d.sourcePath === "README.md")).toBe(false);
    expect(getDocMeta("design-history")?.sourcePath).toBe("docs/DESIGN_HISTORY.md");
  });

  it("has a landable doc for every group, so no group renders empty", () => {
    for (const group of DOC_GROUPS) {
      expect(DOCS.some((d) => d.group === group), `empty group ${group}`).toBe(true);
    }
  });
});

describe("stripLayoutHtml", () => {
  it("removes standalone layout-only tags but keeps content and inline HTML", () => {
    const input = [
      '<div align="center">',
      "",
      "# Radulf",
      "",
      "See <code>foo</code> for details.",
      "<br>",
      "</div>",
      "Body text.",
    ].join("\n");
    const out = stripLayoutHtml(input);
    expect(out).not.toMatch(/<div/);
    expect(out).not.toMatch(/<br>/);
    expect(out).not.toMatch(/<\/div>/);
    expect(out).toContain("# Radulf");
    expect(out).toContain("See <code>foo</code> for details."); // inline HTML untouched
    expect(out).toContain("Body text.");
  });
});

describe("resolveDocHref", () => {
  const GITHUB = "https://github.com/lhansen-dev/radulf/blob/main";

  it.each([
    ["keeps a same-page anchor", "docs/HOW_IT_WORKS.md", "#card-states", "#card-states", false],
    ["passes https through as external", "README.md", "https://ghuntley.com/loop/", "https://ghuntley.com/loop/", true],
    ["passes mailto through as external", "README.md", "mailto:x@y.com", "mailto:x@y.com", true],
    ["neutralizes a dangerous scheme", "README.md", "javascript:alert(1)", "#", false],
    ["rewrites a relative link between registered docs to a wiki route", "docs/DESIGN_HISTORY.md", "HOW_IT_WORKS.md", "/docs/how-it-works", false],
    ["keeps the anchor on a wiki route", "docs/DESIGN_HISTORY.md", "SANDBOXING.md#role-capability-split", "/docs/sandboxing#role-capability-split", false],
    // specs/ is unregistered: links into it (from the design-history page and
    // the guides' ../specs/ references) must not dead-end.
    ["sends a spec link to GitHub", "docs/SANDBOXING.md", "../specs/14-sandboxing.md", `${GITHUB}/specs/14-sandboxing.md`, true],
    ["keeps the anchor on a spec link", "docs/DESIGN_HISTORY.md", "../specs/00-overview.md#locked-decisions", `${GITHUB}/specs/00-overview.md#locked-decisions`, true],
    ["sends any other unregistered file to GitHub", "README.md", "LICENSE", `${GITHUB}/LICENSE`, true],
  ])("%s", (_label, from, href, expected, external) => {
    expect(resolveDocHref(from, href)).toEqual({ href: expected, external });
  });
});
