import fs from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

import { SENSITIVE_ROOTS } from "./scripts/sanitize-next-traces.mjs";

/**
 * Turbopack panics — `Symlink [project]/node_modules is invalid, it points out
 * of the filesystem root` — when `<project>/node_modules` is a symlink that
 * resolves above its root, which is how a checkout shares one install between
 * git worktrees instead of running `npm ci` in every one of them. Next infers
 * the root from the nearest lockfile and deliberately stops at the worktree
 * boundary (`find-root.js` treats a worktree as its own repository), so no
 * on-disk layout can widen it; only `turbopack.root` can. Returns the deepest
 * directory holding both the project and the real node_modules, or undefined
 * when node_modules is an ordinary directory inside the project — the normal
 * case (fresh clone, Docker image), where the root is left untouched.
 */
function sharedNodeModulesRoot(projectDir: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync(path.join(projectDir, "node_modules"));
  } catch {
    return undefined;
  }
  const rel = path.relative(projectDir, real);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) return undefined;
  const projectParts = projectDir.split(path.sep);
  const targetParts = real.split(path.sep);
  let shared = 0;
  while (shared < projectParts.length && shared < targetParts.length && projectParts[shared] === targetParts[shared]) shared++;
  // Splitting an absolute path yields a leading "", so the filesystem root
  // ("/" here, where the worktree and the shared install are different trees)
  // joins back to an empty string.
  return projectParts.slice(0, shared).join(path.sep) || path.sep;
}

const nodeModulesRoot = sharedNodeModulesRoot(process.cwd());

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    proxyClientMaxBodySize: "1mb",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
              "form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
              "script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  // Only present when node_modules was symlinked in from outside (see above).
  ...(nodeModulesRoot ? { turbopack: { root: nodeModulesRoot } } : {}),
  // The pi coding-agent SDK (the one harness — spec 13) is a large Node package
  // with dynamic requires and a TUI dependency surface. Keep it out of the
  // bundler and require it at runtime from node_modules — it only runs in the
  // orchestrator, never in a page. This also silences the harmless
  // "expression is too dynamic" MODULE_NOT_FOUND probes at page-data collection.
  // @anthropic-ai/sandbox-runtime (spec 14 L1) ships platform-specific native
  // binaries (bwrap, seccomp filters, srt-win) resolved via dynamic requires
  // — same reason as pi-coding-agent above. Keep it external too.
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@anthropic-ai/sandbox-runtime"],
  // Runtime worktrees, transcripts, private plans, and benchmark reports are
  // created after deployment and must never be copied into production output.
  // The same roots scripts/sanitize-next-traces.mjs strips after the build.
  outputFileTracingExcludes: {
    "/*": ["./.env*", ...SENSITIVE_ROOTS.map((root) => `./${root}/**/*`)],
  },
  // The Docs wiki reads repo markdown from disk at request time. Trace those
  // files into the standalone build so the routes work in production, not just
  // in `next dev` (which runs from the repo root). Keep in sync with the doc
  // registry in `src/server/docs.ts`.
  outputFileTracingIncludes: {
    "/docs": ["./README.md", "./SECURITY.md", "./CONTRIBUTING.md", "./docs/**/*.md", "./specs/**/*.md"],
    "/docs/[slug]": ["./README.md", "./SECURITY.md", "./CONTRIBUTING.md", "./docs/**/*.md", "./specs/**/*.md"],
  },
};

export default nextConfig;
