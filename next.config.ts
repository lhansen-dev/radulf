import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./benchmarks/reports/**/*"],
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
