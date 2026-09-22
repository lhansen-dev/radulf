import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The in-app documentation wiki (the "Docs" tab). This is the single registry
 * of every repo document surfaced in the UI. Files are read from disk at request
 * time so the wiki always reflects what is actually in the tree — there is no
 * build step and nothing to keep in sync by hand.
 *
 * Physical location is deliberately decoupled from the wiki: `specs/` stays put
 * (agents and the sandbox doc-allowlist key off that literal path — see
 * `src/shared/docPaths.ts` and the planner/evaluator prompts), while loose
 * guides live under `docs/`. The registry points at wherever each file lives.
 *
 * **The wiki is curated, not exhaustive.** `specs/` is a dated decision log
 * containing superseded designs (09 → 12 → 13 decided the harness three times),
 * so listing all sixteen specs buried the handful of docs a new user actually
 * needs and presented overturned decisions as current. Specs stay on disk —
 * agents read them and the doc allowlist covers them — but reach the UI through
 * a single `design-history` page that links out to GitHub with supersession
 * marked. Same for completed implementation plans. Anything not registered here
 * still resolves: `resolveDocHref` sends unregistered relative links to GitHub.
 *
 * README.md is likewise not registered. It is the GitHub landing page, and its
 * first job there — clone, install, run — is noise to a reader who is already
 * looking at the running app. The Start-here group covers that audience instead.
 */

export type DocGroup = "Start here" | "Guides" | "Reference";

export interface DocMeta {
  /** URL slug: /docs/<slug>. Stable, kebab-case. */
  slug: string;
  /** Display title in the index and sidebar. */
  title: string;
  /** One-line description shown on the index. */
  description: string;
  group: DocGroup;
  /** Path relative to the repo root (process.cwd()). */
  sourcePath: string;
}

/** GitHub blob base for links that point outside the wiki (LICENSE, images…). */
const GITHUB_BLOB_BASE = "https://github.com/lhansen-dev/radulf/blob/main";

/** Group render order. */
export const DOC_GROUPS: DocGroup[] = ["Start here", "Guides", "Reference"];

export const DOCS: DocMeta[] = [
  {
    slug: "what-is-radulf",
    title: "What Radulf is",
    description: "The idea in one page: a self-driving agent loop, and what makes that safe.",
    group: "Start here",
    sourcePath: "docs/WHAT_IS_RADULF.md",
  },
  {
    slug: "getting-started",
    title: "Getting started",
    description: "From a fresh clone to your first merged card.",
    group: "Start here",
    sourcePath: "docs/GETTING_STARTED.md",
  },
  {
    slug: "how-it-works",
    title: "How it works",
    description: "The card lifecycle, the three agent roles, and where the work happens.",
    group: "Start here",
    sourcePath: "docs/HOW_IT_WORKS.md",
  },
  {
    slug: "providers",
    title: "Providers & models",
    description: "The five providers, configuring each role, and how to choose sensibly.",
    group: "Guides",
    sourcePath: "docs/PROVIDERS.md",
  },
  {
    slug: "improvement-runs",
    title: "Improvement Runs",
    description: "The time-boxed self-driving loop: one proposal per cycle, auto-approved onto one feature branch.",
    group: "Guides",
    sourcePath: "docs/IMPROVEMENT_RUNS.md",
  },
  {
    slug: "sandboxing",
    title: "Sandboxing",
    description: "How agent runs are contained: Seatbelt on macOS, bubblewrap + seccomp on Linux.",
    group: "Guides",
    sourcePath: "docs/SANDBOXING.md",
  },
  {
    slug: "authentication",
    title: "Authentication",
    description: "Putting Radulf behind a password when you expose it beyond localhost.",
    group: "Guides",
    sourcePath: "docs/AUTHENTICATION.md",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description: "Keyed on the exit reasons and error strings Radulf actually prints.",
    group: "Guides",
    sourcePath: "docs/TROUBLESHOOTING.md",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The contributor's map: where each part of the pipeline lives in the tree.",
    group: "Reference",
    sourcePath: "docs/ARCHITECTURE.md",
  },
  {
    slug: "design-history",
    title: "Design history",
    description: "The specs, what each decided, and which ones later specs overturned.",
    group: "Reference",
    sourcePath: "docs/DESIGN_HISTORY.md",
  },
  {
    slug: "security",
    title: "Security policy",
    description: "The trust model in one page, and how to report a vulnerability.",
    group: "Reference",
    sourcePath: "SECURITY.md",
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Dev setup, conventions, and how to propose a change.",
    group: "Reference",
    sourcePath: "CONTRIBUTING.md",
  },
];

const BY_SLUG = new Map(DOCS.map((d) => [d.slug, d]));
const BY_SOURCE = new Map(DOCS.map((d) => [d.sourcePath, d]));

export function listDocs(): DocMeta[] {
  return DOCS;
}

export function getDocMeta(slug: string): DocMeta | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Drop lines that are *nothing but* a layout-only HTML tag (`<div align=…>`,
 * `</div>`, `<br>`, `<picture>`, …). We render markdown with raw HTML disabled,
 * so such tags would otherwise show up as literal text — most visibly the
 * `<div align="center">` wrappers in the README. Only whole-line, layout-only
 * tags are removed; inline HTML and any tag carrying real text is left alone.
 */
export function stripLayoutHtml(content: string): string {
  const layoutTag = /^\s*<\/?(?:div|p|br|center|picture|source|span)(?:\s[^>]*?)?\/?>\s*$/i;
  return content
    .split("\n")
    .filter((line) => !layoutTag.test(line))
    .join("\n");
}

/** Load a doc's raw markdown. Returns null if the slug is unknown. */
export async function readDoc(slug: string): Promise<{ meta: DocMeta; content: string } | null> {
  const meta = BY_SLUG.get(slug);
  if (!meta) return null;
  const abs = path.join(process.cwd(), meta.sourcePath);
  const content = stripLayoutHtml(await readFile(abs, "utf8"));
  return { meta, content };
}

/**
 * Resolve a link found inside a rendered doc.
 *
 * - Anchors (`#section`) stay in-page.
 * - Absolute http(s)/mailto links pass through as external.
 * - Any other scheme (javascript:, data:, …) is neutralized to `#` — this
 *   markdown is trusted repo content, but treating unknown schemes as inert
 *   matches react-markdown's default `urlTransform` and costs nothing.
 * - Relative links are resolved against the current doc's directory. If they
 *   land on another registered doc, they become an in-wiki `/docs/<slug>` link;
 *   otherwise they point at the file on GitHub so nothing dead-ends in the app.
 */
export function resolveDocHref(
  fromSourcePath: string,
  href: string,
): { href: string; external: boolean } {
  const raw = href.trim();
  if (!raw) return { href: "#", external: false };
  if (raw.startsWith("#")) return { href: raw, external: false };

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme || raw.startsWith("//")) {
    if (scheme && /^(https?|mailto)$/i.test(scheme[1])) {
      return { href: raw, external: true };
    }
    if (raw.startsWith("//")) return { href: `https:${raw}`, external: true };
    return { href: "#", external: false };
  }

  // Relative path — split off any anchor, resolve against the doc's directory.
  const hashIndex = raw.indexOf("#");
  const relPath = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : raw.slice(hashIndex);
  const fromDir = path.posix.dirname(fromSourcePath);
  const resolved = path.posix
    .normalize(path.posix.join(fromDir, relPath))
    .replace(/^\.\//, "");

  const target = BY_SOURCE.get(resolved);
  if (target) return { href: `/docs/${target.slug}${anchor}`, external: false };
  return { href: `${GITHUB_BLOB_BASE}/${resolved}${anchor}`, external: true };
}
