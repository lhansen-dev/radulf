# radulf — the authoritative task runner. Run `make` or `make help` for the list.
# Targets invoke the underlying tools directly; nothing here delegates to
# package.json scripts, so this file is the single source of truth for how the
# project is built, tested, and released.

# Project-local binaries (next, eslint, tsc, vitest, drizzle-kit) live here.
# Reference them via $(BIN) rather than relying on PATH, which Apple's make 3.81
# does not honor for exported values. Also put the dir on PATH for any child
# tool that shells out to a sibling binary.
BIN := node_modules/.bin
export PATH := $(CURDIR)/node_modules/.bin:$(PATH)

# drizzle-kit (unlike `next dev`) does not read .env.local, so the DB targets
# source it in-shell first — `set -a` auto-exports the assignments — to pick up
# RADULF_DATA_DIR and hit the SAME sqlite file the app uses. Missing file is a
# no-op; unset var falls back to ./data (matching the app default).
LOADENV := set -a; [ -f .env.local ] && . ./.env.local; set +a;

# SECURITY.md invariant: never listen beyond loopback without auth. Next's own
# default is 0.0.0.0 for both `dev` and `start`, so the bind address has to be
# passed explicitly — without this the no-auth default (which skips the login
# gate entirely) is reachable from the whole LAN. Auth configured
# (RADULF_AUTH_PASSWORD_HASH set, in the environment or .env.local) -> bind all
# interfaces; auth off -> loopback only. Override with `make dev HOST=...`.
HOST := $(shell $(LOADENV) [ -n "$$RADULF_AUTH_PASSWORD_HASH" ] && echo 0.0.0.0 || echo 127.0.0.1)

# Override with `make dev PORT=...` to match a non-default `next dev` port.
PORT := 3000

.DEFAULT_GOAL := help
.PHONY: help install dev build start web lint typecheck test check check-split check-compose login \
        worker build-worker db-generate db-migrate db-studio db-backup clean release

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	npm ci

# Subscription providers (Claude, ChatGPT, Copilot) authenticate through pi's
# own TUI, and pi writes auth.json into whatever PI_CODING_AGENT_DIR names. That
# must be the SAME dir Radulf reads (`piAgentDir()` in src/server/harness/pi.ts
# = <data dir>/pi-agent), or the app sees no logged-in provider. Hence this
# target rather than a bare `pi` the user runs from their own shell.
login: ## Log in a subscription provider (opens pi; type /login)
	@$(LOADENV) PI_CODING_AGENT_DIR="$${RADULF_DATA_DIR:-$(CURDIR)/data}/pi-agent" $(BIN)/pi

dev: ## Run the dev server (loopback-only unless auth is configured); restarts if already up
	@pid=$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN); \
	if [ -n "$$pid" ]; then \
		echo "Port $(PORT) already in use (pid $$pid) — stopping it"; \
		kill $$pid; \
		for _ in $$(seq 1 20); do kill -0 $$pid 2>/dev/null || break; sleep 0.25; done; \
		kill -0 $$pid 2>/dev/null && kill -9 $$pid; \
		true; \
	fi
	$(BIN)/next dev -H $(HOST) -p $(PORT)

build: build-worker ## Production build: the Next.js bundle plus dist/worker.mjs
	NODE_ENV=production $(BIN)/next build

# esbuild resolves the `@/` alias from tsconfig.json and leaves every
# node_modules package external, so the bundle is the `src/server` + `src/db`
# graph and nothing else; Node runs it directly, no TypeScript loader needed.
build-worker: ## Bundle the worker-only entry point (src/worker.ts) into dist/worker.mjs
	$(BIN)/esbuild src/worker.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/worker.mjs --log-level=warning

worker: build-worker ## Run a worker-only process (agent work, no HTTP) against this checkout
	@$(LOADENV) RADULF_ROLES=worker node dist/worker.mjs

# NEXT_MANUAL_SIG_HANDLE: Next's own SIGTERM/SIGINT handler exits as soon as
# open connections close and would pre-empt Radulf's drain (src/server/shutdown.ts).
start: ## Serve the production build (loopback-only unless auth is configured)
	NEXT_MANUAL_SIG_HANDLE=1 $(BIN)/next start -H $(HOST)

web: ## Serve the production build as a web-only process (no agent work; pair with make worker)
	NEXT_MANUAL_SIG_HANDLE=1 RADULF_ROLES=web $(BIN)/next start -H $(HOST)

lint: ## Lint
	$(BIN)/eslint

typecheck: ## Type-check without emitting
	$(BIN)/tsc --noEmit

test: ## Run the test suite once
	$(BIN)/vitest run

# Skipped by plain `make test` (describe.skipIf on RADULF_SPLIT_CHECK) because it
# spawns two real `next start` web processes and a real worker process. Needs
# the production build because both web processes run `next start`.
check-split: build ## Boot two web-only and a worker-only process against a temp data dir and drive a card through the web API (needs the production build)
	RADULF_SPLIT_CHECK=1 $(BIN)/vitest run src/server/splitProcesses.test.ts

check: test lint typecheck build check-split ## Full gate: test + lint + typecheck + build + split-process check (what CI runs)

# Runs under its own compose project name with a scratch env file so it never
# touches the operator's `radulf` project: separate volume, separate port
# (RADULF_CHECK_PORT, default 3999). `down -v` removes only this project's volumes.
check-compose: ## Throwaway compose run: one web + two workers under project name radulf-check with a scratch env file; never touches the operator's volume or port
	env_file=$$(mktemp); \
	printf 'RADULF_PORT=%s\n' "$${RADULF_CHECK_PORT:-3999}" > "$$env_file"; \
	docker compose -p radulf-check --env-file "$$env_file" up -d --build --scale worker=2 \
		&& docker compose -p radulf-check ps \
		&& docker compose -p radulf-check --env-file "$$env_file" down -v; \
	rm -f "$$env_file"

db-generate: ## Generate a migration from schema changes
	$(BIN)/drizzle-kit generate

db-migrate: ## Apply pending migrations (usually unnecessary: the app migrates at boot)
	@$(LOADENV) mkdir -p "$${RADULF_DATA_DIR:-data}"; $(BIN)/drizzle-kit migrate

db-studio: ## Open Drizzle Studio
	@$(LOADENV) $(BIN)/drizzle-kit studio

# WAL mode (src/db/index.ts) means a plain `cp` of the DB file while the server
# is running can miss uncommitted WAL frames and produce a torn snapshot;
# VACUUM INTO reads through a consistent view instead. Requires the sqlite3
# CLI — a dev-machine convenience, not something CI needs.
db-backup: ## Back up the SQLite DB safely while the server is running
	@$(LOADENV) dir="$${RADULF_DATA_DIR:-data}"; \
	sqlite3 "$$dir/radulf.db" "VACUUM INTO '$$dir/radulf-backup-$$(date +%Y%m%d-%H%M%S).db'"

clean: ## Remove build output and caches
	rm -rf .next dist tsconfig.tsbuildinfo

release: ## Cut a release: make release VERSION=1.0.0 (or 1.1.0-beta.1 from beta)
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make release VERSION=1.0.0"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "Working tree is dirty; commit or stash first."; exit 1; }
	@# Enforce the branch model: stable tags come off main, prereleases off beta.
	@# A hyphen in VERSION marks a prerelease (1.1.0-beta.1). Tagging a stable
	@# release from beta would ship unpromoted work under a "Latest" release.
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	case "$(VERSION)" in \
	  *-*) want=beta ;; \
	  *)   want=main ;; \
	esac; \
	test "$$branch" = "$$want" || { echo "VERSION=$(VERSION) must be cut from '$$want', but HEAD is on '$$branch'."; exit 1; }
	$(MAKE) check
	npm version $(VERSION) -m "release v%s"
	git push --follow-tags
	@echo "Pushed tag v$(VERSION) — the Release workflow will build and publish it."
