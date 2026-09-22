# Radulf as a container image. Two stages: `build` compiles the Next.js bundle
# with the full dev toolchain; `runtime` carries only what `next start` and
# the orchestrator's subprocesses need. docs/DOCKER.md covers running it.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The Makefile is the single source of truth for install and build
# (AGENTS.md), so the image goes through it too rather than calling npm and
# next by hand. python3 and g++ are for better-sqlite3, which ships neither
# an install script nor a prebuilt binary, so npm falls back to its default
# `node-gyp rebuild`; the compiled module is copied into the runtime stage,
# the compiler is not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends make python3 g++ \
 && rm -rf /var/lib/apt/lists/*
COPY Makefile package.json package-lock.json ./
RUN make install
COPY . .
# .next/cache is the incremental-build cache; nothing serves it at runtime.
# `npm prune` drops the dev toolchain (typescript, eslint, vitest, drizzle-kit)
# and keeps the native better-sqlite3 build that `make install` produced.
RUN make build \
 && rm -rf .next/cache \
 && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
# What the orchestrator and the Linux sandbox shell out to:
#   git                       worktrees, merges, diffs (src/server/git.ts)
#   gh                        pull-request delivery, spec 15 (src/server/github.ts);
#                             GitHub's own apt repo, Debian's package is years old
#   bubblewrap socat ripgrep  @anthropic-ai/sandbox-runtime's Linux dependencies,
#                             the same three .github/actions/linux-sandbox-deps installs
#   procps                    `sysctl`, for the AppArmor userns check in sandboxPreflight
#   make                      repos whose agent runs drive `make` (this one included)
#   sqlite3                   `VACUUM INTO` backups, as the Makefile's db-backup does
#   curl ca-certificates      the healthcheck below, and TLS trust for provider calls
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends git gh bubblewrap socat ripgrep procps make sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Host-side commits (merges, plan syncs) run with the container's git config.
# With no identity git derives one from the hostname, and inside a container
# that fails with "unable to auto-detect email address". System scope, so a
# ~/.gitconfig in the persisted home overrides it. Agent commits are
# unaffected: their env sets GIT_CONFIG_SYSTEM=/dev/null and a fixed identity.
RUN git config --system user.name Radulf \
 && git config --system user.email radulf@localhost

# One volume holds everything that must outlive the container. Radulf derives
# worktrees/, plans/ and runtmp/ as siblings of the data dir (src/db/index.ts),
# so they land here too. HOME sits beside them so gh's login and any
# ~/.gitconfig persist as well; data/ and $HOME are both denied to agent bash
# by the sandbox, worktrees/ and plans/ are not, exactly as on a host install.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    RADULF_DATA_DIR=/var/lib/radulf/data \
    HOME=/var/lib/radulf/home
RUN mkdir -p /var/lib/radulf/data /var/lib/radulf/home \
 && chown -R node:node /var/lib/radulf
VOLUME /var/lib/radulf

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
# Read from disk at request time, relative to the working directory:
# migrations at boot (src/db/index.ts), the agent prompt templates
# (src/server/settings.ts), the Docs tab (src/server/docs.ts), and the
# benchmark runner (src/server/benchmarks.ts).
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/src/prompts ./src/prompts
COPY --from=build --chown=node:node /app/docs ./docs
COPY --from=build --chown=node:node /app/specs ./specs
COPY --from=build --chown=node:node /app/benchmarks ./benchmarks
COPY --from=build --chown=node:node /app/README.md /app/SECURITY.md /app/CONTRIBUTING.md ./

# `make login` without make: opens pi against Radulf's own agent dir, the one
# piAgentDir() in src/server/harness/pi.ts reads, so a subscription login lands
# where the app looks for it. Invoked by path on purpose: node_modules/.bin is
# kept off PATH because the sandbox turns every PATH entry into an agent
# read-allow root (toolchainReadRootsFromPath in src/server/sandbox/srt.ts).
COPY <<'SH' /usr/local/bin/radulf-login
#!/bin/sh
exec env PI_CODING_AGENT_DIR="$RADULF_DATA_DIR/pi-agent" /app/node_modules/.bin/pi "$@"
SH
RUN chmod 755 /usr/local/bin/radulf-login

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
# Binds every interface INSIDE the container; the port publish decides what
# the host exposes. compose.yaml publishes on 127.0.0.1 unless RADULF_BIND
# says otherwise, keeping SECURITY.md's loopback-without-auth rule at the host
# boundary. A bare `docker run -p 3000:3000` exposes the no-auth default to
# the whole LAN; publish on 127.0.0.1:3000:3000 or set the auth hash first.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
