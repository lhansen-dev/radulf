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

.DEFAULT_GOAL := help
.PHONY: help install dev build start lint typecheck test check login \
        db-generate db-migrate db-studio clean release

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

dev: ## Run the dev server (loopback-only unless auth is configured)
	$(BIN)/next dev -H $(HOST)

build: ## Production build
	NODE_ENV=production $(BIN)/next build

start: ## Serve the production build (loopback-only unless auth is configured)
	$(BIN)/next start -H $(HOST)

lint: ## Lint
	$(BIN)/eslint

typecheck: ## Type-check without emitting
	$(BIN)/tsc --noEmit

test: ## Run the test suite once
	$(BIN)/vitest run

check: test lint typecheck build ## Full gate: test + lint + typecheck + build (what CI runs)

db-generate: ## Generate a migration from schema changes
	$(BIN)/drizzle-kit generate

db-migrate: ## Apply pending migrations (usually unnecessary: the app migrates at boot)
	@$(LOADENV) mkdir -p "$${RADULF_DATA_DIR:-data}"; $(BIN)/drizzle-kit migrate

db-studio: ## Open Drizzle Studio
	@$(LOADENV) $(BIN)/drizzle-kit studio

clean: ## Remove build output and caches
	rm -rf .next tsconfig.tsbuildinfo

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
