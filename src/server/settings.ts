import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, settings, upsertSettingJson } from "@/db";
import { invalid, record } from "./requestValidation";
import { decryptSecret, encryptSecret } from "./settingsCrypto";
import { parseContextWindowLines, parseHeaderLines } from "./localEndpoint";
import { REASONING_LEVELS } from "@/shared/providers";
import { errorMessage } from "@/shared/errorMessage";

function readBuiltInPromptTemplate(fileName: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src", "prompts", fileName),
    "utf8",
  );
}

/** Versioned prompt files remain the defaults until a user customizes them. */
export const PROMPT_TEMPLATE_DEFAULTS = {
  plannerPromptTemplate: readBuiltInPromptTemplate("plan.md"),
  evaluatorPromptTemplate: readBuiltInPromptTemplate("evaluate.md"),
  improvePromptTemplate: readBuiltInPromptTemplate("improve.md"),
  criticPromptTemplate: readBuiltInPromptTemplate("critique.md"),
} as const;

// Spec 30: when the read-only plan critic reviews a plan before the loop.
// `breakdown` = on for cards that are pieces of an epic, `always`, `off`; a
// card's own `planCritic` column overrides.
export const PLAN_CRITIC_MODES = ["breakdown", "always", "off"] as const;
export type PlanCriticMode = (typeof PLAN_CRITIC_MODES)[number];
const PLAN_CRITIC_MODE_SET = new Set<string>(PLAN_CRITIC_MODES);

export const SETTING_DEFAULTS = {
  plannerProvider: "anthropic",
  plannerModel: "",
  loopProvider: "anthropic",
  loopModel: "",
  evaluatorProvider: "anthropic",
  evaluatorModel: "",
  // Spec 17: the scoping session is interactive and read-only, and the
  // operator is waiting on every turn, so it gets its own seat rather than
  // riding on whatever was chosen for batch planning.
  scopingProvider: "anthropic",
  scopingModel: "",
  // Spec 30: the read-only plan critic that reviews each plan between
  // planning and the loop. Its own seat, like scoping.
  criticProvider: "anthropic",
  criticModel: "",
  // The one directory the repository picker may browse. Blank means the server
  // user's home directory. Everything the picker lists is confined beneath
  // this, resolved through symlinks, because unlike the old native dialog this
  // is an HTTP surface and Radulf binds 0.0.0.0 once auth is configured.
  folderBrowserRoot: "",
  omlxBaseUrl: "http://127.0.0.1:8000",
  omlxApiKey: "",
  // Extra headers for the local endpoint, one `Name: value` per line, for a
  // gateway that authenticates on a header of its own (Kong's `kong-api-key`)
  // rather than the bearer token above. Sent with every request to it.
  omlxHeaders: "",
  // Context windows for the local endpoint's models, one `model-id: tokens`
  // per line, for a server that reports none at /v1/models (or reports the
  // wrong one). An entry wins over the served number; a model with neither
  // runs on the harness's conservative default.
  omlxContextWindows: "",
  openrouterApiKey: "",
  // Brave Search API key. When set, the planner gains a `web_search` tool —
  // planner only, since the loop and evaluator hold bash and must not also hold
  // network reach (spec 14 role split). Blank → the tool is still registered but
  // fails loudly when invoked.
  braveApiKey: "",
  // Jira import in the New Task dialog: the site's base URL, the Atlassian
  // account email and an API token for that account. Read-only: Radulf fetches
  // an issue to prefill a card and never writes to Jira. Blank URL disables it.
  jiraBaseUrl: "",
  jiraEmail: "",
  jiraApiToken: "",
  // Per-agent reasoning/thinking effort, applied to every provider via the pi
  // session's thinking level (spec 13 — one harness, so nothing ignores these).
  // "medium" mirrors pi's own built-in default, so these are no-ops until
  // changed. Pi clamps an unsupported level to the nearest the model honors.
  plannerReasoningLevel: "medium",
  loopReasoningLevel: "medium",
  evaluatorReasoningLevel: "medium",
  scopingReasoningLevel: "medium",
  criticReasoningLevel: "medium",
  // Spec 20: how many of a repo's cards may hold a harness at once (planning,
  // looping or evaluating). 1 keeps the serial queue locked decision 5
  // describes. Forced back to 1 whenever the loop provider is local, since
  // that decision's reason is the machine's unified memory, not the pipeline.
  maxConcurrentCards: 1,
  // A planning pass is one harness invocation, separate from the loop's
  // card-wide budget below.
  plannerTimeoutMinutes: 30,
  defaultMaxIterations: 50,
  defaultTimeoutMinutes: 60,
  // Spec 11: per-iteration hard cap, always bounded by the run's remaining
  // timeout. A single timeout retries once; a second one anywhere in the same
  // run ends it (spec 18 §2).
  iterationHardTimeoutMinutes: 10,
  // Like planning, evaluation is one harness invocation after a completed
  // loop, rather than part of the loop's card-wide budget.
  evaluatorTimeoutMinutes: 10,
  // Spec 30: one critic pass is one harness invocation.
  criticTimeoutMinutes: 10,
  // Spec 30 — `breakdown` = on for cards that are pieces of an epic, `always`,
  // `off`; a card's own `planCritic` column overrides.
  planCriticMode: "breakdown",
  // Spec 27: caps a repository's gate command, which the orchestrator runs
  // before each evaluation cycle on repositories that declare one. Separate
  // from the evaluator's own budget: the gate is a build and a suite, not a
  // model call.
  gateTimeoutMinutes: 30,
  // Kill ANY harness invocation that emits nothing for this long — planner,
  // loop, evaluator, improvement proposer, scoping. A hung provider
  // stream, dropped wifi, or laptop sleep otherwise burns that call's whole
  // timeout in silence (30 min for a plan, 15 for a proposer pass).
  // NOT a slowness cap: pi streams `thinking_delta` while a model reasons, and
  // every streamed event resets the watchdog, so a genuinely slow high-effort
  // turn is never killed by this. Only a dead stream is.
  stallTimeoutSeconds: 300,
  // How long a worker process may go without a heartbeat before another
  // worker treats it as dead and reclaims its runs. Floor is well above the
  // heartbeat interval so a busy-but-alive process is never reaped.
  workerStaleSeconds: 120,
  autoMode: true,
  minimalToolset: false,
  // Global auto-approve: skip the human In Review gate on an evaluator
  // `approve`. OFF by default — turning it on hands merge authority to the LLM
  // evaluator, so the toggle carries a warning and a confirm.
  //
  // This is a LIVE override, not a seed. The effective value for a card is
  // `card.autoApprove || settings.autoApprove`, read at evaluator-verdict time
  // (evaluationService's `approve` branch), so flipping it here changes the
  // behavior of work already in flight. A card's own flag remains an
  // independent opt-in that survives this being off. Which of the two granted
  // an auto-approval is recorded on the `card.auto_approved` event, so the
  // decision stays reconstructable after the fact.
  autoApprove: false,
  // Spec 15: workspace-wide PR delivery — an approved diff is pushed to
  // `origin` and opened as a pull request instead of merged into the local
  // base branch. Live override read at approval time, OR'd with the card's own
  // `openPr` flag. Like the sandbox keys, deliberately NOT model-reachable: no
  // tool binding exists for settings, and none may ever be added for this one,
  // because it is what lets an approved diff leave the machine.
  openPr: false,
  // Spec 14: the ONE sandbox escape hatch. Default on; turning it off shows a
  // persistent UI warning and stamps `sandboxed: false` on every affected run.
  // Deliberately NOT model-reachable — no tool binding exists for settings, and
  // none may ever be added for this key.
  sandboxEnabled: true,
  // Spec 14: extra egress domains for the L1 sandbox, one per line. Registries
  // (registry.npmjs.org) are always included; empty means registries only.
  // Help text must name the residual: the proxy allows by hostname without
  // terminating TLS, so every added domain is a potential domain-fronting path.
  sandboxNetworkAllowlist: "",
  // Spec 14: opt-in, default OFF. Go's TLS verifier (and every Go-based tool —
  // gh, gcloud, terraform, kubectl) calls SecTrustEvaluate → the macOS trustd
  // daemon, which the Seatbelt profile blocks by default, so their HTTPS fails
  // under the sandbox. Enabling this allows trustd (srt's
  // enableWeakerNetworkIsolation). RESIDUAL, named in the help text: trustd
  // runs outside the sandbox and makes OCSP/CRL requests that bypass the egress
  // proxy — a low-bandwidth exfil channel. Off keeps isolation strict; turn it
  // on only if a repo's toolchain needs it. Like sandboxEnabled, NOT
  // model-reachable. macOS-only in effect (no-op on Linux).
  sandboxWeakerIsolationForGoTls: false,
  notificationsEnabled: false,
  // Spec 18 §5: how long a card may sit in Needs Attention before the
  // orchestrator says so. Browser notifications only reach an operator with a
  // tab open, which is how one card went unnoticed for 86 minutes.
  attentionStaleMinutes: 15,
  // Spec 18 §5: where card.attention_stale goes to leave this machine. Empty
  // means nowhere, which is the default. A bare webhook on purpose — ntfy,
  // Slack, Discord and a handler of your own all take the same POST.
  alertWebhookUrl: "",
  // Which other events that webhook announces. The stale sweep above is
  // unconditional — it is the alert spec 18 §5 was written for — but waiting
  // for a card to go stale is the wrong signal for the moment it first needs a
  // human: a diff cleared by the evaluator reaches an operator today only
  // through the browser Notification API, which requires a tab already open on
  // the right machine. Default on, and every one of them is a no-op until
  // `alertWebhookUrl` is set.
  alertOnReviewReady: true,
  alertOnNeedsAttention: true,
  alertOnImprovementRunFinished: true,
  soundEnabled: false,
  theme: "default",
  ...PROMPT_TEMPLATE_DEFAULTS,
} as const;

export type Settings = { [K in keyof typeof SETTING_DEFAULTS]: (typeof SETTING_DEFAULTS)[K] extends number ? number : (typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : string };

// "mock" is always a known provider, even on a server without
// RADULF_MOCK_LLM=1: getSettings() drops values that fail validation back to
// the default, so gating it here would silently turn a stored "mock" into a
// paid provider. The run itself refuses instead (harness/mock.ts).
const PROVIDERS = new Set(["anthropic", "chatgpt", "copilot", "omlx", "openrouter", "mock"]);
export { REASONING_LEVELS };
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const REASONING_LEVEL_SETTINGS = new Set<keyof Settings>([
  "plannerReasoningLevel",
  "loopReasoningLevel",
  "evaluatorReasoningLevel",
  "scopingReasoningLevel",
  "criticReasoningLevel",
]);
const THEMES = new Set([
  "default",
  "default-light",
  "solarized-dark",
  "solarized-light",
  "tokyo-night",
  "tokyo-day",
  "nord",
  "nord-light",
  "gruvbox-dark",
  "gruvbox-light",
]);
const BOOLEAN_SETTINGS = new Set<keyof Settings>([
  "autoMode",
  "minimalToolset",
  "notificationsEnabled",
  "soundEnabled",
  "sandboxEnabled",
  "sandboxWeakerIsolationForGoTls",
  "autoApprove",
  "openPr",
  "alertOnReviewReady",
  "alertOnNeedsAttention",
  "alertOnImprovementRunFinished",
]);
const INTEGER_SETTINGS: Partial<Record<keyof Settings, [number, number]>> = {
  // Upper bound is a guard rail, not a capability claim: past a handful of
  // concurrent worktrees the machine, not Radulf, is the limit (spec 20).
  maxConcurrentCards: [1, 8],
  plannerTimeoutMinutes: [1, 10_080],
  defaultMaxIterations: [1, 1_000],
  defaultTimeoutMinutes: [1, 10_080],
  iterationHardTimeoutMinutes: [1, 1_440],
  evaluatorTimeoutMinutes: [1, 10_080],
  criticTimeoutMinutes: [1, 10_080],
  gateTimeoutMinutes: [1, 1_440],
  stallTimeoutSeconds: [30, 86_400],
  workerStaleSeconds: [15, 86_400],
  attentionStaleMinutes: [1, 10_080],
};
/** Renamed keys, old → new. `getSettings` replays a stored legacy row onto its
 * successor so a customized value survives the rename; the orphan row is left
 * alone and ignored thereafter. */
const LEGACY_SETTING_KEYS: Record<string, keyof Settings> = {
  // Was loop-only; now applies to every model call.
  loopStallTimeoutSeconds: "stallTimeoutSeconds",
  // Was a seed for each new card's flag; now a live global override read at
  // evaluator-verdict time. A user who had the old default on keeps that
  // intent — it just starts applying to existing cards too.
  defaultAutoApprove: "autoApprove",
};
const PRIMARY_PROVIDER_SETTINGS = new Set<keyof Settings>([
  "plannerProvider",
  "loopProvider",
  "evaluatorProvider",
  "scopingProvider",
  "criticProvider",
]);
const PROMPT_TEMPLATE_SETTINGS = new Set<keyof Settings>(
  Object.keys(PROMPT_TEMPLATE_DEFAULTS) as (keyof typeof PROMPT_TEMPLATE_DEFAULTS)[],
);
const MAX_PROMPT_TEMPLATE_LENGTH = 100_000;

/** Provider credentials. Never leave the server in cleartext — see
 * `redactSettings`. Everything server-side reads them via `getSettings()`,
 * which is unredacted; only the HTTP layer redacts. */
const SECRET_SETTINGS = new Set<keyof Settings>([
  "omlxApiKey",
  "omlxHeaders",
  "openrouterApiKey",
  "braveApiKey",
  "jiraApiToken",
]);

/** Stand-in a stored secret is replaced with on the way out. Distinct from ""
 * so the UI can tell "a key is set" from "no key set" without seeing it. */
export const REDACTED = "••••••••";

/**
 * Copy of `settings` safe to hand to a client: every non-empty secret becomes
 * `REDACTED`, empty ones stay empty. `patchSettings` treats an incoming
 * `REDACTED` as "leave this one alone", so the settings form can round-trip
 * the whole object without ever holding — or overwriting — the real value.
 */
export function redactSettings(value: Settings): Settings {
  const out = { ...value };
  for (const key of SECRET_SETTINGS) {
    if (out[key]) (out as Record<string, unknown>)[key] = REDACTED;
  }
  return out;
}

export function validateSettingsPatch(value: unknown): Partial<Settings> {
  const body = record(value, "settings body");
  const patch: Partial<Settings> = {};
  for (const [rawKey, settingValue] of Object.entries(body)) {
    if (!(rawKey in SETTING_DEFAULTS)) invalid(`unknown setting: ${rawKey}`);
    const key = rawKey as keyof Settings;
    if (BOOLEAN_SETTINGS.has(key)) {
      if (typeof settingValue !== "boolean") invalid(`${key} must be a boolean`);
    } else if (INTEGER_SETTINGS[key]) {
      const [min, max] = INTEGER_SETTINGS[key]!;
      if (!Number.isInteger(settingValue) || (settingValue as number) < min || (settingValue as number) > max) {
        invalid(`${key} must be an integer between ${min} and ${max}`);
      }
    } else if (PRIMARY_PROVIDER_SETTINGS.has(key)) {
      if (typeof settingValue !== "string" || !PROVIDERS.has(settingValue)) {
        invalid(`${key} must be a known provider`);
      }
    } else if (key === "theme") {
      if (typeof settingValue !== "string" || !THEMES.has(settingValue)) {
        invalid("theme must be a known theme");
      }
    } else if (key === "planCriticMode") {
      if (typeof settingValue !== "string" || !PLAN_CRITIC_MODE_SET.has(settingValue)) {
        invalid(`planCriticMode must be one of: ${PLAN_CRITIC_MODES.join(", ")}`);
      }
    } else if (REASONING_LEVEL_SETTINGS.has(key)) {
      if (typeof settingValue !== "string" || !REASONING_LEVEL_SET.has(settingValue)) {
        invalid(`${key} must be one of: ${REASONING_LEVELS.join(", ")}`);
      }
    } else if (key === "folderBrowserRoot") {
      if (typeof settingValue !== "string") invalid("folderBrowserRoot must be a path");
      // Blank is meaningful (fall back to $HOME); anything else must be
      // absolute, since a relative root would resolve against whatever the
      // server's cwd happens to be.
      if (settingValue.trim() && !settingValue.trim().startsWith("/") && !settingValue.trim().startsWith("~")) {
        invalid("folderBrowserRoot must be an absolute path");
      }
    } else if (key === "omlxBaseUrl") {
      if (typeof settingValue !== "string") invalid("omlxBaseUrl must be a URL");
      let url: URL;
      try {
        url = new URL(settingValue);
      } catch {
        invalid("omlxBaseUrl must be a URL");
      }
      if (!["http:", "https:"].includes(url.protocol)) invalid("omlxBaseUrl must use http or https");
    } else if (key === "jiraBaseUrl") {
      if (typeof settingValue !== "string") invalid("jiraBaseUrl must be a URL");
      // Blank disables the import; anything else must be a site URL.
      if (settingValue.trim()) {
        let url: URL;
        try {
          url = new URL(settingValue.trim());
        } catch {
          invalid("jiraBaseUrl must be a URL");
        }
        if (!["http:", "https:"].includes(url.protocol)) invalid("jiraBaseUrl must use http or https");
      }
    } else if (key === "omlxHeaders") {
      if (typeof settingValue !== "string") invalid("omlxHeaders must be a string");
      // The form echoes a stored value back as REDACTED (see patchSettings).
      if (settingValue !== REDACTED) {
        try {
          parseHeaderLines(settingValue);
        } catch (e) {
          invalid(`omlxHeaders: ${errorMessage(e)}`);
        }
      }
    } else if (key === "omlxContextWindows") {
      if (typeof settingValue !== "string") invalid("omlxContextWindows must be a string");
      try {
        parseContextWindowLines(settingValue);
      } catch (e) {
        invalid(`omlxContextWindows: ${errorMessage(e)}`);
      }
    } else if (PROMPT_TEMPLATE_SETTINGS.has(key)) {
      if (typeof settingValue !== "string") invalid(`${key} must be a string`);
      if (settingValue.length > MAX_PROMPT_TEMPLATE_LENGTH) {
        invalid(`${key} must be at most ${MAX_PROMPT_TEMPLATE_LENGTH} characters`);
      }
    } else if (typeof settingValue !== "string") {
      invalid(`${key} must be a string`);
    }
    (patch as Record<string, unknown>)[key] = settingValue;
  }
  return patch;
}

export function getSettings(): Settings {
  const rows = db.select().from(settings).all();
  const out = { ...SETTING_DEFAULTS } as Settings;
  const apply = (key: string, rawValue: string) => {
    try {
      const stored: unknown = JSON.parse(rawValue);
      // Stored value may be encrypted (current writes) or legacy plaintext
      // (rows written before this module existed) — decryptSecret handles both.
      // Decrypt before validating: a format check has to see the plaintext.
      let plain: unknown = stored;
      if (SECRET_SETTINGS.has(key as keyof Settings) && typeof stored === "string") {
        try {
          plain = decryptSecret(stored);
        } catch (e) {
          // The row is encrypted under a key derived from `data/auth-secret`,
          // and SECURITY.md documents deleting that file as the kill switch
          // for a leaked session cookie. Doing it also makes every stored
          // provider key undecryptable, and the catch-all below used to
          // swallow that: the key read as unset, the next run failed with "no
          // API key", and nothing connected the two. Say it instead — the row
          // is intact, and re-entering the key in Settings is the fix.
          console.warn(
            `[radulf] ${key} could not be decrypted: data/auth-secret no longer matches the ` +
              `value stored for it (rotated or replaced). Re-enter the key in Settings. ` +
              errorMessage(e),
          );
          return;
        }
      }
      const validated = validateSettingsPatch({ [key]: plain });
      const value = validated[key as keyof Settings];
      // Blank templates are a reset signal, never an executable prompt.
      if (PROMPT_TEMPLATE_SETTINGS.has(key as keyof Settings) &&
          typeof value === "string" && !value.trim()) return;
      (out as Record<string, unknown>)[key] = value;
    } catch {
      // Ignore legacy/corrupt values and retain the safe default.
    }
  };
  // Legacy rows first, so a row written under the current name always wins.
  for (const row of rows) {
    const renamed = LEGACY_SETTING_KEYS[row.key];
    if (renamed && !rows.some((r) => r.key === renamed)) apply(renamed, row.value);
  }
  for (const row of rows) {
    if (row.key in out) apply(row.key, row.value);
  }
  return out;
}

export function patchSettings(value: unknown) {
  const patch = validateSettingsPatch(value);
  for (const [key, rawValue] of Object.entries(patch)) {
    if (!(key in SETTING_DEFAULTS) || rawValue === undefined) continue;
    // The client only ever saw REDACTED for this one, so it is echoing back
    // what we sent it, not setting a key to the bullet string. Leave the
    // stored secret untouched. Clearing still works: "" is not REDACTED.
    if (SECRET_SETTINGS.has(key as keyof Settings) && rawValue === REDACTED) continue;
    // Encrypt at rest — see settingsCrypto.ts. Empty string ("" = "no key
    // set") short-circuits inside encryptSecret and is stored as-is.
    const value = SECRET_SETTINGS.has(key as keyof Settings) && typeof rawValue === "string" && rawValue !== ""
      ? encryptSecret(rawValue)
      : rawValue;
    if (
      PROMPT_TEMPLATE_SETTINGS.has(key as keyof Settings) &&
      (typeof value !== "string" || !value.trim() || value === SETTING_DEFAULTS[key as keyof Settings])
    ) {
      // Do not persist built-ins: future versioned prompt improvements should
      // continue to apply until the user has made a real customization.
      db.delete(settings).where(eq(settings.key, key)).run();
      continue;
    }
    upsertSettingJson(key, value);
  }
}
