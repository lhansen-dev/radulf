"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "../ui/api";
import { playAlertSound, requestNotificationPermission, showCardNotification } from "../ui/notify";
import { AppShell } from "../ui/appShell";
import { useSettingsData, type PromptTemplateSettings } from "./useSettingsData";

type ProviderModel = {
  value: string;
  displayName: string;
  description: string;
  reasoningEfforts?: string[];
  reasoningMandatory?: boolean;
  /** USD per 1M tokens, when the provider reports pricing. Undefined for
   * oMLX — a local model has no market rate. */
  costPerMillionInput?: number;
  costPerMillionOutput?: number;
};

type GithubStatusResponse = {
  ok: boolean;
  account: string | null;
  reason: "missing" | "unauthenticated" | null;
  detail: string | null;
};

/**
 * Whether `gh` can deliver a pull request right now (spec 15).
 *
 * Read-only and deliberately so — Radulf has no GitHub login of its own, by
 * design: interactive OAuth belongs in the operator's terminal, the same
 * position `make login` takes for the subscription providers. So this reports
 * and points at the fix; it never performs one. The re-check bypasses the
 * server's 30s cache, because the whole flow is "fix it in a terminal, come
 * straight back".
 */
function GithubSection() {
  const [status, setStatus] = useState<GithubStatusResponse | null>(null);
  // Starts true: the first check is already in flight from the effect below.
  const [checking, setChecking] = useState(true);

  // Inline rather than reusing `recheck`, which sets state synchronously — a
  // sync setState in an effect body is what react-hooks/set-state-in-effect
  // forbids.
  useEffect(() => {
    let live = true;
    api<GithubStatusResponse>("/api/github/status")
      .then((next) => { if (live) setStatus(next); })
      .catch(() => { if (live) setStatus(null); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api<GithubStatusResponse>("/api/github/status?refresh=1"));
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  const dot = status === null ? "bg-slate-500" : status.ok ? "bg-green-400" : "bg-amber-400";
  return (
    <section id="github" className="scroll-mt-4 flex flex-col gap-3">
      <h2 className="font-medium">GitHub</h2>
      <p className="text-sm text-foreground/55">
        Needed only to deliver an approved diff as a pull request instead of merging it
        locally. Radulf uses the GitHub CLI and never logs in for you.
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/[0.07] bg-foreground/[0.025] px-3 py-2 text-sm">
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="text-foreground/70">
          {status === null
            ? checking ? "Checking…" : "Could not check the GitHub CLI"
            : status.ok
              ? status.account
                ? <>Signed in to GitHub as <strong className="font-medium text-foreground/90">{status.account}</strong></>
                : "GitHub CLI is signed in"
              : status.detail}
        </span>
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          className="ml-auto touch-target rounded-md bg-foreground/10 px-3 text-sm font-medium hover:bg-foreground/15 disabled:opacity-40"
        >
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>
      {status && !status.ok && (
        <p className="text-xs text-foreground/45">
          {status.reason === "missing"
            ? <>Install it, then re-check. Pull-request delivery stays unavailable until then; everything else is unaffected.</>
            : <>Run <code>gh auth login</code> in a terminal on this machine, then re-check.</>}
        </p>
      )}
    </section>
  );
}

/** $3.00 for typical prices, $0.075 for very cheap ones — 2 decimals loses
 * sub-cent-per-million models (e.g. Haiku-class) by rounding them to $0.00. */
function formatPricePerMillion(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude subscription)" },
  { id: "omlx", label: "oMLX (local)" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "chatgpt", label: "ChatGPT (Codex subscription)" },
  { id: "copilot", label: "GitHub Copilot (subscription)" },
] as const;

// Mirror of REASONING_LEVELS in src/server/settings.ts (pi's --thinking ladder);
// the server validates, this only populates the picker.
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Levels to offer for the picked model, ordered by the canonical ladder. When
 * the provider advertises the model's supported efforts (OpenRouter), narrow to
 * those — plus "off" unless reasoning is mandatory. Otherwise (the subscription
 * providers, oMLX, an unlisted/custom id, or the list not yet loaded) offer the
 * full ladder; pi clamps anything the model can't honor. `current` is always kept so the
 * <select> never renders blank against a stored value the model dropped.
 */
function availableReasoningLevels(
  selected: ProviderModel | undefined,
  current: string,
): string[] {
  const efforts = selected?.reasoningEfforts;
  if (!efforts || efforts.length === 0) return [...REASONING_LEVELS];
  const allowed = new Set<string>(efforts);
  if (!selected?.reasoningMandatory) allowed.add("off");
  allowed.add(current);
  return REASONING_LEVELS.filter((level) => allowed.has(level));
}

const MODEL_HINTS: Record<string, string> = {
  anthropic: "Claude model id; blank = subscription default (make login)",
  chatgpt: "ChatGPT/Codex model id; blank = subscription default (make login)",
  copilot: "GitHub Copilot model id; blank = subscription default (make login)",
  omlx: "model id served by oMLX — must support tool use",
  openrouter: "OpenRouter model id, e.g. anthropic/claude-opus-4.5",
};

const inputCls = "bg-foreground/5 border border-foreground/10 rounded px-2 py-1.5 text-sm w-full";

export default function SettingsPage() {
  const {
    settings,
    setSettings,
    repos,
    saved,
    error,
    setError,
    refetch,
    save,
  } = useSettingsData();
  const [cleanupDays, setCleanupDays] = useState(90);
  const [cleanupResult, setCleanupResult] = useState("");

  async function cleanupHistory() {
    setError("");
    setCleanupResult("");
    try {
      const result = await api<{
        runsDeleted: number;
        eventsDeleted: number;
        transcriptEntriesDeleted: number;
      }>("/api/maintenance/cleanup", { json: { olderThanDays: cleanupDays } });
      setCleanupResult(
        `Deleted ${result.runsDeleted} runs, ${result.eventsDeleted} events, and ${result.transcriptEntriesDeleted} transcript entries.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function restoreBuiltInPromptTemplates() {
    setError("");
    try {
      const defaults = await api<PromptTemplateSettings>(
        "/api/settings/prompt-template-defaults",
      );
      setSettings({ ...settings!, ...defaults });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!settings) return <AppShell><div className="flex min-h-[70dvh] items-center justify-center p-8 text-foreground/50">{error || "Loading settings…"}</div></AppShell>;

  // Same provider+model as the loop means the evaluator grades the model that
  // did the work, sharing its blind spots when grading its own output —
  // advisory only, never a save-blocking validation error.
  const evaluatorMatchesLoop =
    settings.evaluatorProvider === settings.loopProvider &&
    settings.evaluatorModel === settings.loopModel;

  return (
    <AppShell>
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 pb-16 sm:px-6 lg:py-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-foreground/35">Workspace configuration</p>
        <h1 tabIndex={-1} className="mt-0.5 text-2xl font-semibold">Settings</h1>
      </header>
      <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        <div className="flex w-max gap-2">
          {[
            ["repos", "Repos"],
            ["agents", "Agents"],
            ["templates", "Templates"],
            ["appearance", "Appearance"],
            ["notifications", "Notifications"],
            ["planner-defaults", "Planner defaults"],
            ["defaults", "Looper defaults"],
            ["evaluator-defaults", "Evaluator defaults"],
            ["github", "GitHub"],
            ["maintenance", "Maintenance"],
          ].map(([id, label]) => <a key={id} href={`#${id}`} className="touch-target flex items-center rounded-full border border-foreground/10 bg-foreground/[0.03] px-3 text-sm text-foreground/65">{label}</a>)}
        </div>
      </nav>
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <section id="appearance" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Theme</h2>
        <select
          value={settings.theme}
          onChange={(e) => setSettings({ ...settings, theme: e.target.value })}
          className={inputCls}
        >
          <option value="default">Default</option>
          <option value="default-light">Default Light</option>
          <option value="solarized-dark">Solarized Dark</option>
          <option value="solarized-light">Solarized Light</option>
          <option value="tokyo-night">Tokyo Night</option>
          <option value="tokyo-day">Tokyo Day</option>
          <option value="nord">Nord</option>
          <option value="nord-light">Nord Light</option>
          <option value="gruvbox-dark">Gruvbox Dark</option>
          <option value="gruvbox-light">Gruvbox Light</option>
        </select>
      </section>

      <ReposSection repos={repos} onChange={refetch} />

      <section id="agents" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Provider credentials</h2>
        <p className="text-xs text-foreground/40">
          Anthropic uses your normal <code>claude</code> CLI login — nothing to configure here.
          oMLX and OpenRouter are optional: configure them only if you want the loop
          to run locally via oMLX or remotely via OpenRouter.
        </p>
        <p className="text-xs text-foreground/40">
          A saved key is never sent back to the browser — it shows as{" "}
          <code>••••••••</code> and stays as it is unless you overwrite it. Clear the
          field and save to remove it.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row">
          <label className="text-sm text-foreground/70 grow">
            oMLX base URL
            <input
              value={settings.omlxBaseUrl}
              onChange={(e) => setSettings({ ...settings, omlxBaseUrl: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="text-sm text-foreground/70 grow">
            oMLX API key
            <input
              type="password"
              value={settings.omlxApiKey}
              onChange={(e) => setSettings({ ...settings, omlxApiKey: e.target.value })}
              placeholder="from oMLX settings (optional)"
              className={inputCls}
            />
          </label>
        </div>
        <label className="text-sm text-foreground/70">
          OpenRouter API key
          <input
            type="password"
            value={settings.openrouterApiKey}
            onChange={(e) => setSettings({ ...settings, openrouterApiKey: e.target.value })}
            placeholder="sk-or-…"
            className={inputCls}
          />
        </label>
        <label className="text-sm text-foreground/70">
          Brave Search API key
          <input
            type="password"
            value={settings.braveApiKey}
            onChange={(e) => setSettings({ ...settings, braveApiKey: e.target.value })}
            placeholder="from search.brave.com/api (enables web_search for every agent)"
            className={inputCls}
          />
        </label>
        <p className="text-xs text-foreground/40">
          Every provider runs the loop under the{" "}
          <a
            href="https://github.com/earendil-works/pi"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            pi coding agent
          </a>
          . The Anthropic, ChatGPT, and Copilot subscription paths authenticate
          through Radulf&rsquo;s own pi agent dir — run <code>make login</code>{" "}
          and type <code>/login</code> there; a login in your personal{" "}
          <code>~/.pi</code> is not read.
        </p>
      </section>

      <AgentSection
        title="Planner agent"
        subtitle="writes the plan — pick something smart"
        provider={settings.plannerProvider}
        model={settings.plannerModel}
        onProvider={(p) => setSettings({ ...settings, plannerProvider: p, plannerModel: "" })}
        onModel={(m) => setSettings({ ...settings, plannerModel: m })}
        reasoningLevel={settings.plannerReasoningLevel}
        onReasoningLevel={(r) => setSettings({ ...settings, plannerReasoningLevel: r })}
        saveFirst={save}
        datalistId="planner-models"
      />

      <AgentSection
        title="Looper agent"
        subtitle="runs the ralph iterations"
        provider={settings.loopProvider}
        model={settings.loopModel}
        onProvider={(p) => setSettings({ ...settings, loopProvider: p, loopModel: "" })}
        onModel={(m) => setSettings({ ...settings, loopModel: m })}
        reasoningLevel={settings.loopReasoningLevel}
        onReasoningLevel={(r) => setSettings({ ...settings, loopReasoningLevel: r })}
        saveFirst={save}
        datalistId="loop-models"
      />

      <AgentSection
        title="Evaluator agent"
        subtitle="reviews the looper's work after DONE — revise sends it back, approve goes to you"
        provider={settings.evaluatorProvider}
        model={settings.evaluatorModel}
        onProvider={(p) => setSettings({ ...settings, evaluatorProvider: p, evaluatorModel: "" })}
        onModel={(m) => setSettings({ ...settings, evaluatorModel: m })}
        reasoningLevel={settings.evaluatorReasoningLevel}
        onReasoningLevel={(r) => setSettings({ ...settings, evaluatorReasoningLevel: r })}
        saveFirst={save}
        datalistId="evaluator-models"
        warning={
          evaluatorMatchesLoop
            ? "The evaluator is currently the same provider and model as the looper agent, so it may share the looper's blind spots when grading its own work. Consider picking a different provider/model for the evaluator."
            : undefined
        }
      />

      <section id="templates" className="scroll-mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">Prompt templates</h2>
            <p className="mt-1 max-w-3xl text-xs text-foreground/45">
              These templates are used for future agent runs. The planning template controls
              how <code>PLAN.md</code>, <code>CRITERIA.md</code>, and <code>PROMPT.md</code> are produced;
              existing card artifacts are not rewritten.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void restoreBuiltInPromptTemplates()}
            className="rounded bg-foreground/10 px-3 py-1.5 text-sm hover:bg-foreground/15"
          >
            Restore built-in templates
          </button>
        </div>
        <PromptTemplateEditor
          title="Planning artifacts"
          description="Instructions for generating PLAN.md, CRITERIA.md, and the loop's PROMPT.md."
          placeholders={["{{TITLE}}", "{{DESCRIPTION}}", "{{FEEDBACK_SECTION}}"]}
          value={settings.plannerPromptTemplate}
          onChange={(plannerPromptTemplate) => setSettings({ ...settings, plannerPromptTemplate })}
        />
        <PromptTemplateEditor
          title="Evaluation"
          description="Instructions used when the evaluator reviews a completed loop."
          placeholders={["{{TITLE}}", "{{DESCRIPTION}}", "{{BASE_BRANCH}}", "{{CRITERIA}}"]}
          value={settings.evaluatorPromptTemplate}
          onChange={(evaluatorPromptTemplate) => setSettings({ ...settings, evaluatorPromptTemplate })}
        />
        <PromptTemplateEditor
          title="Self-improvement"
          description="Instructions used by an improvement run to propose the next change from a repository review."
          placeholders={["{{EXISTING_CARDS}}", "{{FOCUS}}"]}
          value={settings.improvePromptTemplate}
          onChange={(improvePromptTemplate) => setSettings({ ...settings, improvePromptTemplate })}
        />
      </section>

      <section id="notifications" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Notifications & sounds</h2>
        <label className="text-sm text-foreground/70 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.notificationsEnabled}
            onChange={(e) =>
              setSettings({ ...settings, notificationsEnabled: e.target.checked })
            }
          />
          Notify me when a task needs my attention (In Review / Needs Attention)
        </label>
        <label className="text-sm text-foreground/70 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.soundEnabled}
            onChange={(e) =>
              setSettings({ ...settings, soundEnabled: e.target.checked })
            }
          />
          Play an alert sound too
        </label>
        <button
          onClick={() => {
            requestNotificationPermission().then((granted) => {
              if (granted) {
                showCardNotification("Radulf", "Notifications are enabled.");
              }
              playAlertSound();
            });
          }}
          className="bg-foreground/10 hover:bg-foreground/15 rounded px-3 py-1.5 text-sm self-start"
        >
          Test notification & sound
        </button>
      </section>

      <section id="planner-defaults" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Planner defaults</h2>
        <label className="max-w-xs text-sm text-foreground/70">
          Timeout (minutes)
          <input
            type="number"
            min={1}
            value={settings.plannerTimeoutMinutes}
            onChange={(e) =>
              setSettings({ ...settings, plannerTimeoutMinutes: Number(e.target.value) || 1 })
            }
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-foreground/40">
            Caps each card&apos;s planning pass.
          </span>
        </label>
      </section>

      <section id="defaults" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Looper defaults</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="text-sm text-foreground/70">
            Max iterations
            <input
              type="number"
              min={1}
              value={settings.defaultMaxIterations}
              onChange={(e) =>
                setSettings({ ...settings, defaultMaxIterations: Number(e.target.value) || 1 })
              }
              className={inputCls}
            />
          </label>
          <label className="text-sm text-foreground/70">
            Timeout (minutes)
            <input
              type="number"
              min={1}
              value={settings.defaultTimeoutMinutes}
              onChange={(e) =>
                setSettings({ ...settings, defaultTimeoutMinutes: Number(e.target.value) || 1 })
              }
              className={inputCls}
            />
          </label>
          <label className="text-sm text-foreground/70">
            Iteration hard timeout (minutes)
            <input
              type="number"
              min={1}
              value={settings.iterationHardTimeoutMinutes}
              onChange={(e) =>
                setSettings({ ...settings, iterationHardTimeoutMinutes: Number(e.target.value) || 1 })
              }
              className={inputCls}
            />
            <span className="mt-1 block text-xs text-foreground/40">
              Caps one iteration; a single timeout retries, two in a row end the run.
            </span>
          </label>
          <label className="text-sm text-foreground/70">
            Stall timeout (seconds)
            <input
              type="number"
              min={30}
              value={settings.stallTimeoutSeconds}
              onChange={(e) =>
                setSettings({ ...settings, stallTimeoutSeconds: Number(e.target.value) || 30 })
              }
              className={inputCls}
            />
            <span className="mt-1 block text-xs text-foreground/40">
              Kills any model call — planner, looper, evaluator, proposer, chat — that emits
              nothing for this long (hung stream, sleep, lost wifi). Streamed reasoning counts
              as output, so this never cuts off a merely slow model.
            </span>
          </label>
        </div>
        <label className="text-sm text-foreground/70 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.minimalToolset}
            onChange={(e) =>
              setSettings({ ...settings, minimalToolset: e.target.checked })
            }
          />
          Minimal tool set (deny-by-default tool permissions for the looper agent)
        </label>
      </section>

      <section id="evaluator-defaults" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Evaluator defaults</h2>
        <label className="max-w-xs text-sm text-foreground/70">
          Timeout (minutes)
          <input
            type="number"
            min={1}
            value={settings.evaluatorTimeoutMinutes}
            onChange={(e) =>
              setSettings({ ...settings, evaluatorTimeoutMinutes: Number(e.target.value) || 1 })
            }
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-foreground/40">
            Caps each evaluation pass after the looper finishes.
          </span>
        </label>
      </section>

      <GithubSection />

      <section id="sandbox" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">Sandbox</h2>
        <p className="text-sm text-foreground/55">
          Kernel-enforced containment (spec 14) on every loop/evaluator bash command —
          filesystem, network, and socket restrictions. This is the one escape hatch; it is
          never reachable by the agent itself.
        </p>
        <label className="text-sm text-foreground/70 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.sandboxEnabled}
            onChange={(e) => setSettings({ ...settings, sandboxEnabled: e.target.checked })}
          />
          Sandbox enabled
        </label>
        <p className="text-xs text-foreground/40">
          Turning this off runs agent bash unsandboxed on this host — a persistent warning
          banner appears everywhere, and every affected run is stamped{" "}
          <code>sandboxed: false</code> in its run detail and in analytics.
        </p>
        <label className="text-sm text-foreground/70">
          Extra network allowlist (one domain per line)
          <textarea
            rows={3}
            value={settings.sandboxNetworkAllowlist}
            onChange={(e) =>
              setSettings({ ...settings, sandboxNetworkAllowlist: e.target.value })
            }
            placeholder="pypi.org"
            className={`${inputCls} font-mono`}
          />
        </label>
        <p className="text-xs text-foreground/40">
          Package registries (registry.npmjs.org) are always reachable. Every domain added here
          widens egress: the proxy allows by requested hostname and does not terminate TLS, so a
          permitted domain is a potential domain-fronting path — add only what a run genuinely
          needs.
        </p>
        <label className="text-sm text-foreground/70 flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.sandboxWeakerIsolationForGoTls}
            onChange={(e) =>
              setSettings({ ...settings, sandboxWeakerIsolationForGoTls: e.target.checked })
            }
          />
          Allow Go/TLS toolchains (weaker isolation, macOS)
        </label>
        <p className="text-xs text-foreground/40">
          Off by default. Go-based tools (go, gh, gcloud, terraform, kubectl) verify TLS via the
          macOS <code>trustd</code> daemon, which the sandbox blocks — so their HTTPS fetches fail
          even for an allowlisted domain. Enabling this permits <code>trustd</code>. Residual:{" "}
          <code>trustd</code> runs outside the sandbox and its OCSP/CRL requests bypass the egress
          proxy — a low-bandwidth exfil channel. Turn on only for repos whose toolchain needs it.
        </p>
      </section>

      <section id="maintenance" className="scroll-mt-4 flex flex-col gap-3">
        <h2 className="font-medium">History retention</h2>
        <p className="text-sm text-foreground/55">
          Delete terminal run history, events, and transcript files older than the selected age.
          Cards and plans are kept.
        </p>
        <label className="max-w-xs text-sm text-foreground/70">
          Keep history for (days)
          <input
            type="number"
            min={1}
            max={3650}
            value={cleanupDays}
            onChange={(event) => setCleanupDays(Number(event.target.value) || 1)}
            className={inputCls}
          />
        </label>
        <button
          type="button"
          onClick={() => void cleanupHistory()}
          className="self-start rounded bg-foreground/10 px-3 py-1.5 text-sm hover:bg-foreground/15"
        >
          Clean up old history
        </button>
        {cleanupResult && <p role="status" className="text-sm text-green-400">{cleanupResult}</p>}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => save().catch(() => {})}
          className="bg-amber-600 hover:bg-amber-500 text-on-accent font-medium rounded px-4 py-2 text-sm"
        >
          Save settings
        </button>
        <span role="status" aria-live="polite" className="text-green-400 text-sm">{saved ? "Settings saved ✓" : ""}</span>
      </div>
    </div>
    </AppShell>
  );
}

function PromptTemplateEditor({
  title,
  description,
  placeholders,
  value,
  onChange,
}: {
  title: string;
  description: string;
  placeholders: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <details className="rounded-lg border border-foreground/10 bg-foreground/[0.02]">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{title}</summary>
      <div className="flex flex-col gap-2 border-t border-foreground/10 p-3">
        <p className="text-xs text-foreground/45">{description}</p>
        <p className="text-xs text-foreground/45">
          Available placeholders:{" "}
          {placeholders.map((placeholder, index) => (
            <span key={placeholder}>
              {index > 0 && ", "}
              <code>{placeholder}</code>
            </span>
          ))}
        </p>
        <textarea
          aria-label={`${title} prompt template`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={18}
          spellCheck={false}
          className={`${inputCls} min-h-72 resize-y font-mono leading-relaxed`}
        />
      </div>
    </details>
  );
}

/** Provider dropdown + model input with a datalist/chips loaded from the provider. */
function AgentSection({
  title,
  subtitle,
  provider,
  model,
  onProvider,
  onModel,
  reasoningLevel,
  onReasoningLevel,
  saveFirst,
  datalistId,
  warning,
}: {
  title: string;
  subtitle: string;
  provider: string;
  model: string;
  onProvider: (p: string) => void;
  onModel: (m: string) => void;
  reasoningLevel: string;
  onReasoningLevel: (r: string) => void;
  saveFirst: () => Promise<void>;
  datalistId: string;
  /** Advisory-only warning rendered under the provider/model pickers, e.g.
   * the evaluator matching the loop's provider+model. Never blocks saving. */
  warning?: string;
}) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [status, setStatus] = useState("");

  // setState only happens in the promise callbacks, never synchronously,
  // so this is safe to call from the effect below.
  // `force` is only ever set by the "Load models" button — see the route.
  const load = useCallback((p: string, force = false) => {
    return api<{ models: ProviderModel[] }>(`/api/providers/${p}/models${force ? "?refresh=1" : ""}`)
      .then((r) => {
        setModels(r.models);
        setStatus(`✓ ${r.models.length} model${r.models.length === 1 ? "" : "s"}`);
      })
      .catch((e) => {
        setModels([]);
        setStatus(`✗ ${e instanceof Error ? e.message : e}`);
      });
  }, []);

  // Refresh the picker whenever the provider changes.
  useEffect(() => {
    void load(provider);
  }, [provider, load]);

  const selectedModel = models.find((m) => m.value === model);
  const reasoningOptions = availableReasoningLevels(selectedModel, reasoningLevel);
  // The model advertises a ladder AND the current pick sits outside it — pi will
  // clamp, so tell the user rather than silently offering a level that snaps.
  const reasoningClamped =
    selectedModel?.reasoningEfforts !== undefined &&
    reasoningLevel !== "off" &&
    !selectedModel.reasoningEfforts.includes(reasoningLevel);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">
        {title} <span className="text-foreground/40 text-sm font-normal">— {subtitle}</span>
      </h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="text-sm text-foreground/70 sm:w-56 sm:shrink-0">
          Provider
          <select
            value={provider}
            onChange={(e) => onProvider(e.target.value)}
            className={inputCls}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-foreground/70 grow">
          Model <span className="text-foreground/40">({MODEL_HINTS[provider] ?? ""})</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={model}
              onChange={(e) => onModel(e.target.value)}
              placeholder={provider === "anthropic" ? "e.g. opus" : "model id"}
              className={inputCls}
              list={datalistId}
            />
            <datalist id={datalistId}>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName}
                </option>
              ))}
            </datalist>
            <button
              onClick={() => {
                setStatus("…");
                saveFirst().then(() => load(provider, true)).catch(() => setStatus(""));
              }}
              title="Save settings, then re-fetch this provider's model list, skipping every cache"
              className="rounded bg-foreground/10 px-3 text-sm whitespace-nowrap hover:bg-foreground/15"
            >
              Load models
            </button>
          </div>
        </label>
        <label className="text-sm text-foreground/70 sm:w-40 sm:shrink-0">
          Reasoning
          <select
            value={reasoningLevel}
            onChange={(e) => onReasoningLevel(e.target.value)}
            title="Thinking effort passed to pi (--thinking). pi clamps it to the model's supported range."
            className={inputCls}
          >
            {reasoningOptions.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          {reasoningClamped && (
            <span className="mt-1 block text-xs text-amber-400/80">
              {selectedModel!.displayName} supports {selectedModel!.reasoningEfforts!.join(", ")} —
              {" "}pi will clamp &ldquo;{reasoningLevel}&rdquo; to the nearest.
            </span>
          )}
        </label>
      </div>
      {warning && <p className="text-xs text-amber-400/80">{warning}</p>}
      {selectedModel &&
        (selectedModel.costPerMillionInput != null || selectedModel.costPerMillionOutput != null) && (
          <p className="text-xs text-foreground/40">
            {selectedModel.costPerMillionInput != null &&
              `${formatPricePerMillion(selectedModel.costPerMillionInput)} / 1M input`}
            {selectedModel.costPerMillionInput != null && selectedModel.costPerMillionOutput != null && " · "}
            {selectedModel.costPerMillionOutput != null &&
              `${formatPricePerMillion(selectedModel.costPerMillionOutput)} / 1M output`}
          </p>
        )}
      {status && (
        <p className={`text-sm ${status.startsWith("✗") ? "text-red-400" : "text-foreground/40"}`}>
          {status}
        </p>
      )}
      {models.length > 0 && models.length <= 30 && (
        <div className="flex flex-wrap gap-1">
          {models.map((m) => (
            <button
              key={m.value}
              onClick={() => onModel(m.value)}
              title={
                m.costPerMillionInput != null || m.costPerMillionOutput != null
                  ? `${m.description || m.value} — ${
                      m.costPerMillionInput != null ? `${formatPricePerMillion(m.costPerMillionInput)}/1M in` : ""
                    }${m.costPerMillionInput != null && m.costPerMillionOutput != null ? ", " : ""}${
                      m.costPerMillionOutput != null ? `${formatPricePerMillion(m.costPerMillionOutput)}/1M out` : ""
                    }`
                  : m.description || m.value
              }
              className={`text-xs rounded px-2 py-1 border ${
                model === m.value
                  ? "border-amber-500 text-amber-400"
                  : "border-foreground/10 text-foreground/60 hover:text-foreground"
              }`}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      )}
      {models.length > 30 && (
        <p className="text-xs text-foreground/40">Type in the model field to search the list.</p>
      )}
    </section>
  );
}

function ReposSection({ repos, onChange }: { repos: Repo[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [notARepo, setNotARepo] = useState(false);
  const [emptyRepo, setEmptyRepo] = useState(false);
  // The picker opens on the machine running the server, so it is useless from a
  // phone or a remote browser — typing stays available as a fallback.
  const [typePath, setTypePath] = useState(false);

  async function chooseFolder() {
    setError("");
    setPicking(true);
    try {
      const picked = await api<{
        path?: string;
        isGitRepo?: boolean;
        hasCommits?: boolean;
        cancelled?: boolean;
      }>("/api/folder-picker", { method: "POST" });
      if (!picked.path) return; // cancelled
      setPath(picked.path);
      setNotARepo(picked.isGitRepo === false);
      setEmptyRepo(picked.isGitRepo === true && picked.hasCommits === false);
      if (!name.trim()) setName(picked.path.split("/").pop() ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTypePath(true);
    } finally {
      setPicking(false);
    }
  }

  async function add() {
    setError("");
    try {
      await api("/api/repos", { json: { name, path, defaultBranch: branch } });
      setName("");
      setPath("");
      setBranch("");
      setNotARepo(false);
      setEmptyRepo(false);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section id="repos" className="scroll-mt-4 flex flex-col gap-3">
      <h2 className="font-medium">Repositories</h2>
      {repos.map((r) => (
        <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded bg-foreground/[0.04] p-2 text-sm">
          <span className="font-medium">{r.name}</span>
          <span className="min-w-0 grow truncate font-mono text-xs text-foreground/40">
            {r.path} → {r.defaultBranch}
          </span>
          <button
            onClick={() =>
              confirm(`Remove "${r.name}"? Its tasks and history will be deleted.`) &&
              api(`/api/repos/${r.id}`, { method: "DELETE" }).then(onChange)
            }
            className="min-h-11 px-2 text-xs text-red-400/70 hover:text-red-400"
          >
            remove
          </button>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_9rem_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className={inputCls}
        />
        {typePath ? (
          <input
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setNotARepo(false);
              setEmptyRepo(false);
            }}
            placeholder="/absolute/path/to/repo"
            className={`${inputCls} font-mono`}
          />
        ) : (
          <button
            type="button"
            onClick={() => void chooseFolder()}
            disabled={picking}
            aria-label="Choose repository folder"
            title={path || undefined}
            className={`${inputCls} flex items-center gap-2 text-left hover:bg-foreground/10 disabled:opacity-60`}
          >
            <span aria-hidden>📁</span>
            <span className={`min-w-0 truncate ${path ? "font-mono" : "text-foreground/40"}`}>
              {picking ? "Waiting for the folder picker…" : path || "Choose folder…"}
            </span>
          </button>
        )}
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch (auto)"
          className={inputCls}
        />
        <button
          onClick={add}
          disabled={!name.trim() || !path.trim()}
          className="bg-foreground/10 hover:bg-foreground/15 disabled:opacity-40 rounded px-3 text-sm whitespace-nowrap"
        >
          Add
        </button>
      </div>
      {notARepo && (
        <p className="text-xs text-amber-400/80">
          That folder is not a git repository — pick the folder containing <code>.git</code>.
        </p>
      )}
      {emptyRepo && (
        <p className="text-xs text-amber-400/80">
          That repository has no commits yet — Radulf branches each task off an existing commit, so
          make an initial commit first.
        </p>
      )}
      {!typePath && (
        <button
          type="button"
          onClick={() => setTypePath(true)}
          className="self-start text-xs text-foreground/40 underline hover:text-foreground/60"
        >
          The picker opens on the machine running Radulf — type the path instead
        </button>
      )}
      {error && <p className="text-red-400 text-sm">{error}</p>}
    </section>
  );
}
