/**
 * There is one harness now: pi, in SDK mode (spec 13). The id is kept as a
 * field on RunnerResult so the per-iteration telemetry column and its migration
 * stay stable — it is simply always the constant "pi".
 */
export type HarnessId = "pi";

/** Per-run values threaded into the agent env (spec 14 L3). */
export type AgentEnvContext = {
  /** Run-private TMPDIR, created at run start and deleted at run end. */
  tmpdir?: string;
  /** Run-private package-manager cache root the host user never consumes. */
  cacheRoot?: string;
  /** Extra allowlisted entries (e.g. whatever srt's proxy injects — L1). */
  extra?: NodeJS.ProcessEnv;
};

/** Constant agent commit identity — required because GIT_CONFIG_GLOBAL is
 * /dev/null (spec 14 checklist #4; a constant is fine). */
export const AGENT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Radulf",
  GIT_AUTHOR_EMAIL: "ralph@radulf.local",
  GIT_COMMITTER_NAME: "Radulf",
  GIT_COMMITTER_EMAIL: "ralph@radulf.local",
} as const;

/**
 * The agent's bash spawn env — a minimal ALLOWLIST (spec 14 L3), not
 * process.env minus known secrets. The agent's bash runs in-process (spec 13),
 * so it would otherwise inherit everything in the shell that launched the
 * server — cloud credentials, GitHub tokens, npm tokens, and Radulf's own
 * session-forging secret. Constructing the env from scratch means unknown
 * secrets stop leaking by default instead of by enumeration.
 *
 * Included: PATH, HOME, LANG/LC_*, TERM=dumb, the run-private TMPDIR and
 * package-manager cache roots, git hardening + constant commit identity, and
 * any ctx.extra entries (srt proxy vars in L1).
 *
 * SSH_AUTH_SOCK is excluded BY CONSTRUCTION, and this is deliberate rather
 * than incidental (spec 14 socket policy): denying ~/.ssh prevents *reading*
 * the key; the agent socket would let a process *use* the key without reading
 * it. A future edit that "helpfully" restores SSH_AUTH_SOCK is a security
 * regression.
 *
 * The OpenRouter key is re-added only via the model-runtime override for
 * OpenRouter runs — never through this env.
 */
export function agentEnv(ctx?: AgentEnvContext): NodeJS.ProcessEnv {
  // Cast: Next's types make NODE_ENV a required ProcessEnv key, but this env
  // is built from nothing by design.
  const env = {} as NodeJS.ProcessEnv;

  // Base process context.
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "LANG" || key.startsWith("LC_")) env[key] = value;
  }
  env.TERM = "dumb";

  // Run-private temp + package-manager caches (spec 14 L3). A shared cache is
  // a sandbox-to-host escape: a poisoned ~/.npm/_cacache would be executed by
  // the host on its next install outside the sandbox.
  env.TMPDIR = ctx?.tmpdir ?? process.env.TMPDIR ?? "/tmp";
  if (ctx?.cacheRoot) {
    env.npm_config_cache = `${ctx.cacheRoot}/npm`;
    env.npm_config_store_dir = `${ctx.cacheRoot}/pnpm-store`;
    env.YARN_CACHE_FOLDER = `${ctx.cacheRoot}/yarn`;
    env.XDG_CACHE_HOME = `${ctx.cacheRoot}/xdg`;
    // Go's module + build caches default under $HOME (~/go, and on macOS
    // ~/Library/Caches/go-build, which XDG_CACHE_HOME does NOT redirect), both
    // write-denied by L1. Point them at the run cache root like npm/yarn so a
    // sandboxed `go mod download`/`go build` works WITHOUT a $HOME re-allow.
    // -modcacherw keeps the module cache writable so the per-run cleanup can
    // delete it (Go marks it read-only by default).
    env.GOPATH = `${ctx.cacheRoot}/go`;
    env.GOMODCACHE = `${ctx.cacheRoot}/go/pkg/mod`;
    env.GOCACHE = `${ctx.cacheRoot}/go-build`;
    env.GOFLAGS = "-modcacherw";
  }

  // Install-script gate (spec 14): agent installs run with lifecycle scripts
  // disabled. Detection never trusts these — the gate inspects the resolved
  // tree — but they keep the default path scriptless.
  env.npm_config_ignore_scripts = "true";
  env.YARN_IGNORE_SCRIPTS = "true";

  // Git hardening (spec 14 L3): no user/system gitconfig, so no credential
  // helpers, aliases, or core.sshCommand reach agent git; no interactive or
  // SSH auth path exists at all.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/bin/false";
  env.GIT_SSH_COMMAND = "/bin/false";
  Object.assign(env, AGENT_GIT_IDENTITY);

  if (ctx?.extra) Object.assign(env, ctx.extra);
  return env;
}

/**
 * Normalization invariant (spec 11 Phase 0): every `usage` event is
 * per-model-turn. Pi reports one assistant `message_end` per turn, so the
 * normalizer emits one usage event per turn and `model_turns` is simply the
 * count — it can never double-count.
 *
 * `inputTokens` is UNCACHED input for the turn; cache reads/writes travel in
 * their own fields. Unavailable fields stay unavailable (undefined) — zero is
 * used only when the harness explicitly reports zero.
 */
export type TranscriptEvent =
  | { t: "text"; role: "assistant"; content: string }
  | {
      t: "tool";
      name: string;
      input: unknown;
      output?: string;
      durationMs?: number;
      timestampMs?: number;
    }
  | {
      t: "usage";
      /** Uncached input tokens for this model turn. */
      inputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
      outputTokens: number;
      reasoningTokens?: number;
      costUsd?: number;
      timestampMs?: number;
    }
  | {
      t: "result";
      exit: "completed" | "failed";
      detail?: string;
      /** Model-turn count when the harness reports one directly. Pi does not,
       * so the usage-event count stands. */
      numTurns?: number;
    }
  | { t: "raw"; line: string };
