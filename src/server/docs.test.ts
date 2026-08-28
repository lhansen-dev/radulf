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

  it("readDoc loads content for a known slug and returns null otherwise", async () => {
    const doc = await readDoc("how-it-works");
    expect(doc?.meta.slug).toBe("how-it-works");
    expect(doc?.content.length).toBeGreaterThan(0);
    expect(await readDoc("does-not-exist")).toBeNull();
  });

  it("getDocMeta / listDocs expose the registry", () => {
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
  it("keeps same-page anchors in place", () => {
    expect(resolveDocHref("docs/HOW_IT_WORKS.md", "#card-states")).toEqual({
      href: "#card-states",
      external: false,
    });
  });

  it("passes through http(s) and mailto as external", () => {
    expect(resolveDocHref("README.md", "https://ghuntley.com/loop/")).toEqual({
      href: "https://ghuntley.com/loop/",
      external: true,
    });
    expect(resolveDocHref("README.md", "mailto:x@y.com").external).toBe(true);
  });

  it("neutralizes dangerous schemes", () => {
    expect(resolveDocHref("README.md", "javascript:alert(1)")).toEqual({
      href: "#",
      external: false,
    });
  });

  it("rewrites a relative cross-doc link between registered docs to a wiki route", () => {
    // docs/DESIGN_HISTORY.md -> HOW_IT_WORKS.md resolves to docs/HOW_IT_WORKS.md
    expect(resolveDocHref("docs/DESIGN_HISTORY.md", "HOW_IT_WORKS.md")).toEqual({
      href: "/docs/how-it-works",
      external: false,
    });
  });

  it("sends links into specs/ out to GitHub now that specs are unregistered", () => {
    // The design-history page links every spec this way, and the guides carry
    // ../specs/ references of their own. None of them should dead-end.
    expect(resolveDocHref("docs/DESIGN_HISTORY.md", "../specs/09-multi-harness.md")).toEqual({
      href: "https://github.com/lhansen-dev/radulf/blob/main/specs/09-multi-harness.md",
      external: true,
    });
    expect(resolveDocHref("docs/SANDBOXING.md", "../specs/14-sandboxing.md").external).toBe(
      true,
    );
  });

  it("preserves an anchor when rewriting to a wiki route", () => {
    expect(resolveDocHref("docs/DESIGN_HISTORY.md", "SANDBOXING.md#role-capability-split")).toEqual(
      { href: "/docs/sandboxing#role-capability-split", external: false },
    );
  });

  it("preserves an anchor when sending a spec link to GitHub", () => {
    expect(
      resolveDocHref("docs/DESIGN_HISTORY.md", "../specs/00-overview.md#locked-decisions").href,
    ).toBe(
      "https://github.com/lhansen-dev/radulf/blob/main/specs/00-overview.md#locked-decisions",
    );
  });

  it("sends unregistered relative files to GitHub so nothing dead-ends", () => {
    const r = resolveDocHref("README.md", "LICENSE");
    expect(r.external).toBe(true);
    expect(r.href).toBe("https://github.com/lhansen-dev/radulf/blob/main/LICENSE");
  });
});
