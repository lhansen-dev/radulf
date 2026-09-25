"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "../ui/api";
import { FolderBrowser } from "../ui/folderBrowser";
import { playAlertSound, requestNotificationPermission, showCardNotification } from "../ui/notify";
import { AppShell } from "../ui/appShell";
import { ModelChips } from "../ui/taskDialog";
import { ProviderLoginSection } from "./providerLogin";
import { SchedulesSection } from "./schedulesSection";
import { useSettingsData, type PromptTemplateSettings, type Settings } from "./useSettingsData";
import type { ProviderUsageRow } from "@/server/providerUsage";
import { PROVIDERS, REASONING_LEVELS, providerLabel, type ProviderModel } from "@/shared/providers";
import {
  SETTINGS_SECTIONS, SettingsNav, SettingsPanel, ThemePicker, ToggleRow,
  inputCls, secondaryButtonCls, sectionCls, useSettingsSection,
} from "./settingsUI";
import { errorMessage } from "@/shared/errorMessage";

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
 * design. Spec 23 moved the provider logins into Settings, so the reason is
 * no longer "interactive OAuth belongs in the terminal": it is that Radulf
 * drives a login where a typed interface exists, and shells out where one
 * does not. pi hands us an `AuthInteraction` to implement; `gh auth login`
 * hands us stdout to scrape, on a contract that can change in any release.
 * So this reports and points at the fix; it never performs one. The re-check bypasses the
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
    <section id="github" className={sectionCls}>
      <div>
        <h3 className="font-medium">GitHub connection</h3>
        <p className="mt-1 text-sm leading-relaxed text-foreground/55">
          Deliver approved work as a pull request using your GitHub CLI account.
        </p>
      </div>
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

/** "$3.00 / 1M input · $15.00 / 1M output", or "" when the provider reports no pricing. */
function priceLabel(m: ProviderModel, input = " / 1M input", output = " / 1M output", sep = " · "): string {
  return [
    m.costPerMillionInput != null && `${formatPricePerMillion(m.costPerMillionInput)}${input}`,
    m.costPerMillionOutput != null && `${formatPricePerMillion(m.costPerMillionOutput)}${output}`,
  ].filter(Boolean).join(sep);
}

/**
 * Levels to offer for the picked model, ordered by the canonical ladder. When
 * the provider advertises the model's supported efforts (OpenRouter), narrow to
 * those — plus "off" unless reasoning is mandatory. Otherwise (the subscription
 * providers, a self-hosted model, an unlisted/custom id, or the list not yet loaded) offer the
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
  anthropic: "Leave blank to use your subscription's default model.",
  chatgpt: "Leave blank to use your subscription's default model.",
  copilot: "Leave blank to use your subscription's default model.",
  omlx: "Use the id of a model your server reports at /v1/models; it must support tool use.",
  openrouter: "Type a model id to search the available models.",
  mock: "The model id picks a scripted scenario. Leave blank for happy-path.",
};

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type StringKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

/**
 * What kind of capability each provider stands for, used by the role-fit
 * advisories below. A subscription login is flat-rate, so a strong model on a
 * role that runs once per card adds no marginal cost; a self-hosted endpoint is
 * the cheap seat for the role that runs every iteration.
 */
const PROVIDER_CLASS: Record<string, "subscription" | "local" | "api" | "mock"> = {
  anthropic: "subscription",
  chatgpt: "subscription",
  copilot: "subscription",
  omlx: "local",
  openrouter: "api",
  mock: "mock",
};

const AGENTS = [
  {
    role: "scoping",
    title: "Scoping agent",
    subtitle: "Sharpens a task with you before it is planned.",
    demand:
      "Runs interactively, one turn at a time, while you wait on it. It reads the repository read-only and asks the questions that make a plan possible. Slow or shallow answers here cost your time directly, and a session is short.",
  },
  {
    role: "planner",
    title: "Planner agent",
    subtitle: "Turns a task into a plan and acceptance criteria.",
    demand:
      "Runs once per card. It reads an unfamiliar repository and produces items the looper executes blind, with no memory between iterations. That is the hardest reasoning in the pipeline, and the cheapest place to spend a strong model.",
  },
  {
    role: "loop",
    title: "Looper agent",
    subtitle: "Works through the plan, one iteration at a time.",
    demand:
      "Runs every iteration up to the max-iterations budget, so it dominates token spend and rate-limit pressure. This is the seat a self-hosted or low-cost model pays for itself in.",
  },
  {
    role: "evaluator",
    title: "Evaluator agent",
    subtitle: "Reviews completed work before it reaches you.",
    demand:
      "Runs once per loop and is the only stage that executes the whole-card acceptance criteria, which the looper never sees. A reviewer that rubber-stamps sends broken work straight to you.",
  },
  {
    role: "critic",
    title: "Plan critic agent",
    subtitle: "Reads each plan before the loop starts.",
    demand:
      "Runs once per plan, read-only, and only when the critic is on for the card. A second reader from a different model than the planner is the point: it names the gap the planner could not see in its own plan.",
  },
] as const;

type AgentRole = (typeof AGENTS)[number]["role"];

/**
 * Advisory when a role's provider does not match what the role demands.
 * Advisory only: it never blocks saving, and a deliberate choice (benchmarking
 * a local planner, say) stays one dropdown away.
 */
function roleFitWarning(role: AgentRole, provider: string): string | undefined {
  const providerClass = PROVIDER_CLASS[provider];
  if (providerClass === "mock" || providerClass === undefined) return undefined;
  if (role === "scoping" && providerClass === "local") {
    return "Scoping is a live conversation about an unfamiliar repository, and you wait on every turn. A self-hosted model is slow to explore and quick to ask generic questions. A subscription model costs you one short session per card here.";
  }
  if (role === "planner" && providerClass === "local") {
    return "Planning is the pipeline's hardest reasoning and runs only once per card. A self-hosted model has to decompose an unfamiliar repository into ordered, self-contained items, and a weak plan degrades every iteration after it. A subscription model costs you one run per card here.";
  }
  if (role === "evaluator" && providerClass === "local") {
    return "The evaluator is the only gate that runs the whole-card acceptance criteria. A self-hosted model that approves work it did not really verify sends it straight to you. A subscription model costs you one run per loop here.";
  }
  if (role === "critic" && providerClass === "local") {
    return "The plan critic is a second reader whose whole job is to catch what the planner missed, and it runs read-only once per plan. A self-hosted model that waves a plan through leaves every iteration after it building on the gap. A subscription model costs you one short run per plan here.";
  }
  if (role === "loop" && providerClass === "subscription") {
    return "The looper runs every iteration up to the max-iterations budget, so it drives most of your token spend and rate-limit pressure. A self-hosted or low-cost model is usually the right seat for this role.";
  }
  return undefined;
}

const TEMPLATES = [
  { key: "plannerPromptTemplate", title: "Planning artifacts", description: "Instructions for generating PLAN.md, CRITERIA.md, and the loop's PROMPT.md.", placeholders: ["{{TITLE}}", "{{DESCRIPTION}}", "{{SCOPING_SECTION}}", "{{FEEDBACK_SECTION}}"] },
  { key: "evaluatorPromptTemplate", title: "Evaluation", description: "Instructions used when the evaluator reviews a completed loop.", placeholders: ["{{TITLE}}", "{{DESCRIPTION}}", "{{BASE_BRANCH}}", "{{CRITERIA}}"] },
  { key: "criticPromptTemplate", title: "Plan critique", description: "Instructions used when the plan critic reviews a plan before the loop starts.", placeholders: ["{{TITLE}}", "{{DESCRIPTION}}", "{{SCOPING_SECTION}}", "{{SPEC_FILES}}", "{{PLAN_VERSION}}", "{{PLAN_MD}}", "{{CRITERIA_MD}}", "{{PROMPT_MD}}"] },
  { key: "improvePromptTemplate", title: "Self-improvement", description: "Instructions used by an improvement run to propose the next change from a repository review.", placeholders: ["{{EXISTING_CARDS}}", "{{FOCUS}}"] },
] as const;

function SectionHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-medium">{title}</h3>
      {children && <p className="mt-1 text-sm leading-relaxed text-foreground/55">{children}</p>}
    </div>
  );
}


export default function SettingsPage() {
  const { settings, setSettings, repos, saved, saving, dirty, error, setError, refetch, save } = useSettingsData();
  const activeSection = useSettingsSection();
  const currentSection = SETTINGS_SECTIONS.find((section) => section.id === activeSection)!;
  const [cleanupDays, setCleanupDays] = useState(90);
  const [cleanupResult, setCleanupResult] = useState("");

  async function cleanupHistory() {
    setError("");
    setCleanupResult("");
    try {
      const result = await api<{ runsDeleted: number; eventsDeleted: number; transcriptEntriesDeleted: number }>(
        "/api/maintenance/cleanup", { json: { olderThanDays: cleanupDays } },
      );
      setCleanupResult(
        `Deleted ${result.runsDeleted} runs, ${result.eventsDeleted} events, and ${result.transcriptEntriesDeleted} transcript entries.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function restoreBuiltInPromptTemplates() {
    setError("");
    try {
      const defaults = await api<PromptTemplateSettings>("/api/settings/prompt-template-defaults");
      setSettings((current) => current ? { ...current, ...defaults } : current);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!settings) return <AppShell><div className="flex min-h-[70dvh] items-center justify-center p-8 text-foreground/50">{error || "Loading settings…"}</div></AppShell>;

  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const toggle = (key: "notificationsEnabled" | "soundEnabled" | "minimalToolset" | "sandboxEnabled" | "sandboxWeakerIsolationForGoTls" | "alertOnReviewReady" | "alertOnNeedsAttention" | "alertOnImprovementRunFinished") =>
    ({ checked: settings[key], onChange: (value: boolean) => set({ [key]: value }) });
  const textInput = (key: StringKey, props: { label: string; type?: string; placeholder?: string }) => (
    <label className="text-sm text-foreground/70">
      {props.label}
      <input type={props.type} value={settings[key]} onChange={(e) => set({ [key]: e.target.value })} placeholder={props.placeholder} className={inputCls} />
    </label>
  );
  const textArea = (key: StringKey, props: { label: string; rows: number; placeholder?: string }) => (
    <label className="text-sm text-foreground/70">
      {props.label}
      <textarea rows={props.rows} value={settings[key]} onChange={(e) => set({ [key]: e.target.value })} placeholder={props.placeholder} className={`${inputCls} font-mono`} />
    </label>
  );
  const numberInput = (key: NumberKey, label: string, hint?: string, min = 1, className = "text-sm text-foreground/70") => (
    <label className={className}>
      {label}
      <input type="number" min={min} value={settings[key]} onChange={(e) => set({ [key]: Number(e.target.value) || min })} className={inputCls} />
      {hint && <span className="mt-1 block text-xs text-foreground/40">{hint}</span>}
    </label>
  );

  // Same provider+model as the loop means the evaluator grades the model that
  // did the work, sharing its blind spots — advisory only, never blocks saving.
  const evaluatorMatchesLoop =
    settings.evaluatorProvider === settings.loopProvider && settings.evaluatorModel === settings.loopModel;
  // Roles whose provider does not match what the role demands, for the summary
  // callout at the top of the agents panel.
  const misfitRoles = AGENTS
    .filter(({ role }) => roleFitWarning(role, settings[`${role}Provider`]))
    .map(({ title }) => title);

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-8 lg:px-10">
        <header className="sticky top-0 z-20 -mx-4 flex items-center justify-between gap-4 border-b border-foreground/10 bg-background/95 px-4 py-5 backdrop-blur-xl sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10 lg:py-7">
          <div>
            <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 hidden text-sm text-foreground/50 sm:block">Workspace preferences and agent configuration.</p>
          </div>
          <div className="flex flex-col-reverse items-end gap-1 sm:flex-row sm:items-center sm:gap-4">
            <span role="status" aria-live="polite" className="text-[11px] text-foreground/55 sm:text-xs">
              {saving ? "Saving changes…" : dirty ? "Unsaved changes" : saved ? "Settings saved ✓" : "All changes saved"}
            </span>
            <button
              type="button"
              onClick={() => save().catch(() => { })}
              disabled={saving || !dirty}
              className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent/85 disabled:opacity-45"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </header>
        <div className="grid items-start gap-6 pt-5 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10 lg:pt-8">
          <SettingsNav active={activeSection} />
          <div className="flex min-w-0 flex-col gap-5">
            <div className="mb-1">
              <h2 className="text-xl font-semibold tracking-tight">{currentSection.label}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground/55">{currentSection.description}</p>
            </div>
            {error && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-400">{error}</p>}

            <SettingsPanel active={activeSection} section="general">
              <div className="flex flex-col gap-5">
                <section id="appearance" className={sectionCls}>
                  <SectionHeading title="Appearance">Pick a color theme. Save your changes to apply it across Radulf.</SectionHeading>
                  <ThemePicker value={settings.theme} onChange={(theme) => set({ theme })} />
                </section>
                <section id="notifications" className={sectionCls}>
                  <SectionHeading title="Notifications & sounds" />
                  <div className="flex flex-col gap-4 divide-y divide-foreground/10">
                    <ToggleRow title="Desktop notifications" description="Get notified when a task is ready for review or needs your attention." {...toggle("notificationsEnabled")} />
                    <div className="pt-4">
                      <ToggleRow title="Alert sounds" description="Play a sound alongside task notifications." {...toggle("soundEnabled")} />
                    </div>
                    <div className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
                      {numberInput("attentionStaleMinutes", "Waiting-too-long alert (minutes)", "How long a card may sit in Needs Attention before Radulf says so. Desktop notifications only reach you with a tab open; this fires either way.")}
                      {textInput("alertWebhookUrl", { label: "Alert webhook URL", type: "url", placeholder: "https://ntfy.sh/your-topic" })}
                    </div>
                    <fieldset className="pt-4" disabled={!settings.alertWebhookUrl.trim()}>
                      <legend className="text-sm font-medium">Send to the webhook</legend>
                      <p className="mt-1 mb-3 text-xs leading-relaxed text-foreground/55">
                        {settings.alertWebhookUrl.trim()
                          ? "A card going stale in Needs Attention is always sent. These are the events that reach you the moment they happen."
                          : "Set an alert webhook URL above to choose which events leave this machine."}
                      </p>
                      <div className="flex flex-col gap-3">
                        <ToggleRow title="Diff ready for review" description="A card cleared the evaluator and is waiting on your approval." {...toggle("alertOnReviewReady")} />
                        <ToggleRow title="Task needs attention" description="A card stopped and needs a decision — sent on arrival, not after the wait above." {...toggle("alertOnNeedsAttention")} />
                        <ToggleRow title="Improvement run finished" description="A run spent its time budget, was stopped, or failed. Its branch is waiting for review." {...toggle("alertOnImprovementRunFinished")} />
                      </div>
                    </fieldset>
                  </div>
                  <button
                    onClick={() => {
                      requestNotificationPermission().then((granted) => {
                        if (granted) showCardNotification("Radulf", "Notifications are enabled.");
                        playAlertSound();
                      });
                    }}
                    className={`${secondaryButtonCls} self-start`}
                  >
                    Test notification & sound
                  </button>
                </section>
              </div>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="repos">
              <div className="flex flex-col gap-5">
                <ReposSection repos={repos} onChange={refetch} />
                <section className={sectionCls}>
                  <SectionHeading title="Browsable root">
                    The one directory the repository picker may browse. Blank means your home
                    directory. Unlike the old native chooser this is an HTTP surface, so it is
                    confined to this root; a repository kept outside it is still reachable by
                    typing its absolute path.
                  </SectionHeading>
                  {textInput("folderBrowserRoot", { label: "Browsable root", placeholder: "$HOME" })}
                </section>
                <GithubSection />
                <section className={sectionCls}>
                  <SectionHeading title="Jira">
                    Paste an issue link or key into the New task dialog to prefill a card from
                    Jira. Read-only: Radulf fetches the issue and never writes to Jira. The token
                    is an Atlassian API token for the account whose email is given, created at{" "}
                    <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="text-accent underline">
                      id.atlassian.com
                    </a>
                    , with or without scopes: Radulf reaches the site through Atlassian&apos;s
                    api.atlassian.com gateway, which accepts both kinds.
                  </SectionHeading>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {textInput("jiraBaseUrl", { label: "Jira base URL", placeholder: "https://your-site.atlassian.net" })}
                    {textInput("jiraEmail", { label: "Atlassian account email", placeholder: "you@example.com" })}
                    {textInput("jiraApiToken", { label: "Jira API token", type: "password", placeholder: "Atlassian API token" })}
                  </div>
                </section>
              </div>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="agents">
              <div id="agents" className="flex scroll-mt-32 flex-col gap-5">
                <ProviderHealthPanel />
                <section className={sectionCls}>
                  <SectionHeading title="Subscriptions and provider logins">Sign in with a subscription, or store an API key, without leaving the app.</SectionHeading>
                  <ProviderLoginSection onChanged={refetch} />
                </section>
                <section className={sectionCls}>
                  <SectionHeading title="Local models">Connect your own OpenAI-compatible server (oMLX, vLLM, LM Studio) running a model that supports tool use.</SectionHeading>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {textInput("omlxBaseUrl", { label: "Local server base URL" })}
                    {textInput("omlxApiKey", { label: "Local server API key", type: "password", placeholder: "optional; many local servers need none" })}
                  </div>
                  {textArea("omlxHeaders", { label: "Extra request headers (one per line)", rows: 2, placeholder: "kong-api-key: …" })}
                  <p className="text-xs text-foreground/40">
                    For a gateway in front of the server that authenticates on a header of its own.
                    Sent with every request alongside the API key; a header named Authorization
                    replaces the key&apos;s bearer token.
                  </p>
                  {textArea("omlxContextWindows", { label: "Context windows (one model per line)", rows: 2, placeholder: "Qwen/Qwen3-8B: 131072" })}
                  <p className="text-xs text-foreground/40">
                    For a server that does not report a context length at /v1/models. An entry here
                    wins over what the server reports; a model with neither runs on a 32,768-token
                    window, so compaction fires early and the loop loses work to it.
                  </p>
                </section>
                <section className={sectionCls}>
                  <SectionHeading title="API keys">Optional services for hosted models and planner web search.</SectionHeading>
                  {textInput("openrouterApiKey", { label: "OpenRouter API key", type: "password", placeholder: "sk-or-…" })}
                  {textInput("braveApiKey", { label: "Brave Search API key", type: "password", placeholder: "Brave Search API key" })}
                </section>
                <p className="px-1 text-xs leading-relaxed text-foreground/50">
                  Saved keys and headers are hidden as <code>••••••••</code>. Leave them as shown to keep them, replace to update, or clear and save to remove.
                </p>
              </div>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="models">
              <div id="models" className="flex scroll-mt-32 flex-col gap-5">
                <RoleFitSummary
                  misfitRoles={misfitRoles}
                  onApply={() => set({
                    scopingProvider: "anthropic", scopingModel: "",
                    plannerProvider: "anthropic", plannerModel: "",
                    evaluatorProvider: "anthropic", evaluatorModel: "",
                    criticProvider: "anthropic", criticModel: "",
                    loopProvider: "omlx", loopModel: "",
                  })}
                />
                {AGENTS.map(({ role, title, subtitle, demand }) => (
                  <AgentSection
                    key={role}
                    title={title}
                    subtitle={subtitle}
                    demand={demand}
                    provider={settings[`${role}Provider`]}
                    model={settings[`${role}Model`]}
                    onProvider={(p) => set({ [`${role}Provider`]: p, [`${role}Model`]: "" })}
                    onModel={(m) => set({ [`${role}Model`]: m })}
                    reasoningLevel={settings[`${role}ReasoningLevel`]}
                    onReasoningLevel={(r) => set({ [`${role}ReasoningLevel`]: r })}
                    saveFirst={save}
                    datalistId={`${role}-models`}
                    warnings={[
                      roleFitWarning(role, settings[`${role}Provider`]),
                      role === "evaluator" && evaluatorMatchesLoop
                        ? "The evaluator uses the same model as the looper and may share its blind spots. Choose a different model for a more independent review."
                        : undefined,
                    ].filter((warning): warning is string => Boolean(warning))}
                  />
                ))}
              </div>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="templates">
              <section id="templates" className={sectionCls}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">Agent instructions</h3>
                    <p className="mt-1 max-w-3xl text-xs text-foreground/45">
                      These templates are used for future agent runs. The planning template controls
                      how <code>PLAN.md</code>, <code>CRITERIA.md</code>, and <code>PROMPT.md</code> are produced;
                      existing card artifacts are not rewritten.
                    </p>
                  </div>
                  <button type="button" onClick={() => void restoreBuiltInPromptTemplates()} className={secondaryButtonCls}>
                    Restore built-in templates
                  </button>
                </div>
                {TEMPLATES.map(({ key, ...template }) => (
                  <PromptTemplateEditor key={key} {...template} value={settings[key]} onChange={(value) => set({ [key]: value })} />
                ))}
              </section>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="schedules">
              <SchedulesSection repos={repos} />
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="defaults">
              <div className="flex flex-col gap-5">
                <section id="planner-defaults" className={sectionCls}>
                  <SectionHeading title="Planning" />
                  {numberInput("plannerTimeoutMinutes", "Timeout (minutes)", "Caps each card's planning pass.", 1, "max-w-xs text-sm text-foreground/70")}
                  {numberInput("criticTimeoutMinutes", "Critic timeout (minutes)", "Caps each plan critique pass.", 1)}
                  <label className="block max-w-xs text-sm text-foreground/70">
                    Plan critic
                    <select
                      value={settings.planCriticMode}
                      onChange={(e) => set({ planCriticMode: e.target.value as Settings["planCriticMode"] })}
                      className={inputCls}
                    >
                      <option value="breakdown">On for tasks created from a breakdown</option>
                      <option value="always">On for every card</option>
                      <option value="off">Off</option>
                    </select>
                    <span className="mt-1 block text-xs text-foreground/45">
                      Which cards get a read-only critique of their plan before the loop starts.
                    </span>
                  </label>
                </section>
                <section id="defaults" className={sectionCls}>
                  <SectionHeading title="Loop execution" />
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    {numberInput("maxConcurrentCards", "Concurrent cards per repo", "How many of one repo's cards may run the planner, loop or evaluator at once. Held at 1 while the loop provider is local, which owns the machine's memory.")}
                    {numberInput("defaultMaxIterations", "Max iterations")}
                    {numberInput("defaultTimeoutMinutes", "Timeout (minutes)")}
                    {numberInput("iterationHardTimeoutMinutes", "Iteration hard timeout (minutes)", "Caps one iteration; a single timeout retries, two in a row end the run.")}
                    {numberInput("stallTimeoutSeconds", "Stall timeout (seconds)", "Kills any model call — planner, looper, evaluator, proposer, scoping — that emits nothing for this long (hung stream, sleep, lost wifi). Streamed reasoning counts as output, so this never cuts off a merely slow model.", 30)}
                    {numberInput("workerStaleSeconds", "Worker stale window (seconds)", "How long a worker process may go without a heartbeat before another worker treats it as dead and reclaims its runs.", 15)}
                  </div>
                  <div className="border-t border-foreground/10 pt-4">
                    <ToggleRow title="Minimal tool set" description="Deny tool permissions by default for the looper agent." {...toggle("minimalToolset")} />
                  </div>
                </section>
                <section id="evaluator-defaults" className={sectionCls}>
                  <SectionHeading title="Evaluation" />
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    {numberInput("evaluatorTimeoutMinutes", "Timeout (minutes)", "Caps each evaluation pass after the looper finishes.", 1)}
                    {numberInput("gateTimeoutMinutes", "Gate timeout (minutes)", "Caps a repository's gate command, which runs in the worktree before each evaluation on repositories that declare one under Connected repositories.", 1)}
                  </div>
                </section>
              </div>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="sandbox">
              <section id="sandbox" className={sectionCls}>
                <SectionHeading title="Agent isolation">Restrict agent commands to their worktree and allowed network destinations.</SectionHeading>
                <ToggleRow title="Sandbox enabled" {...toggle("sandboxEnabled")} />
                <p className="text-xs text-foreground/40">
                  Turning this off runs agent bash unsandboxed on this host — a persistent warning
                  banner appears everywhere, and every affected run is stamped{" "}
                  <code>sandboxed: false</code> in its run detail and in analytics.
                </p>
                {textArea("sandboxNetworkAllowlist", { label: "Extra network allowlist (one domain per line)", rows: 3, placeholder: "pypi.org" })}
                <p className="text-xs text-foreground/40">
                  Package registries (registry.npmjs.org) are always reachable. Every domain added here
                  widens egress: the proxy allows by requested hostname and does not terminate TLS, so a
                  permitted domain is a potential domain-fronting path — add only what a run genuinely
                  needs.
                </p>
                <div className="border-t border-foreground/10 pt-5">
                  <ToggleRow title="Allow Go/TLS toolchains" description="Weaker isolation · macOS only" {...toggle("sandboxWeakerIsolationForGoTls")} />
                </div>
                <p className="text-xs text-foreground/40">
                  Off by default. Go-based tools (go, gh, gcloud, terraform, kubectl) verify TLS via the
                  macOS <code>trustd</code> daemon, which the sandbox blocks — so their HTTPS fetches fail
                  even for an allowlisted domain. Enabling this permits <code>trustd</code>. Residual:{" "}
                  <code>trustd</code> runs outside the sandbox and its OCSP/CRL requests bypass the egress
                  proxy — a low-bandwidth exfil channel. Turn on only for repos whose toolchain needs it.
                </p>
              </section>
            </SettingsPanel>

            <SettingsPanel active={activeSection} section="maintenance">
              <section id="maintenance" className={sectionCls}>
                <SectionHeading title="History retention">
                  Delete terminal run history, events, and transcript files older than the selected age. Cards and plans are kept.
                </SectionHeading>
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
                  className="self-start rounded-lg border border-red-400/25 bg-red-400/5 px-3.5 py-2 text-sm font-medium text-red-400 hover:bg-red-400/10"
                >
                  Clean up old history
                </button>
                {cleanupResult && <p role="status" className="text-sm text-green-400">{cleanupResult}</p>}
              </section>
            </SettingsPanel>
          </div>
        </div>
      </main>
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
  placeholders: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <details className="group rounded-lg border border-foreground/10 bg-background">
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 p-4">
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-foreground/50">{description}</span>
        </span>
        <span aria-hidden="true" className="text-foreground/40 transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-foreground/10 p-4">
        <p className="text-xs leading-relaxed text-foreground/55">
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

/** How often the health panel re-reads usage while the settings page is open. */
const PROVIDER_HEALTH_POLL_MS = 60_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** "in 42m" / "in 3h 10m": how long a provider stays blocked. */
function formatUntil(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "shortly";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Per-provider usage and breaker state over a trailing window.
 *
 * This is deliberately framed as what Radulf observed, not as a quota reading:
 * the subscriptions publish no remaining-allowance endpoint through pi, so the
 * token counts come from Radulf's own runs and "limit reached" comes from what
 * the provider said when a run failed.
 */
function ProviderHealthPanel() {
  const [rows, setRows] = useState<ProviderUsageRow[]>([]);
  const [windowHours, setWindowHours] = useState(24);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<{ windowHours: number; providers: ProviderUsageRow[] }>("/api/providers/usage")
        .then((r) => {
          if (cancelled) return;
          // Defensive: a settings page that blanks out because a usage payload
          // arrived in an unexpected shape would be a bad trade for a panel
          // that is only ever advisory.
          setRows(Array.isArray(r.providers) ? r.providers : []);
          setWindowHours(typeof r.windowHours === "number" ? r.windowHours : 24);
          setNowMs(Date.now());
          setError("");
        })
        .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    void load();
    const timer = setInterval(() => void load(), PROVIDER_HEALTH_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Providers with no runs in the window and a healthy breaker say nothing
  // worth a row; keeping them would bury the two or three that are in use.
  const interesting = rows.filter((row) => row.runs > 0 || row.breaker.state === "open");

  return (
    <section aria-labelledby="provider-health-title" className={sectionCls}>
      <div>
        <h3 id="provider-health-title" className="font-medium">Provider usage and health</h3>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-foreground/55">
          What Radulf has spent through each provider in the last {windowHours} hours, and whether
          any of them is currently refusing work. Subscriptions publish no remaining-allowance
          figure, so these are Radulf&rsquo;s own totals, not a quota reading.
        </p>
      </div>
      {error && <p role="status" className="text-sm text-red-400">{error}</p>}
      {!error && interesting.length === 0 && (
        <p className="text-sm text-foreground/45">No runs in the last {windowHours} hours.</p>
      )}
      {interesting.map((row) => (
        <div key={row.provider} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-foreground/10 pt-3 first-of-type:border-t-0 first-of-type:pt-0">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {providerLabel(row.provider)}
            </p>
            {row.rateLimit && (
              <p className="mt-1 text-xs leading-relaxed text-foreground/55">
                {row.rateLimit.windows
                  .filter((w) => w.utilization !== null)
                  .map((w) => `${w.label} ${Math.round((w.utilization ?? 0) * 100)}% used`)
                  .join(" · ") || "reported, no window detail"}
                {row.rateLimit.resetAt && ` · resets ${formatUntil(row.rateLimit.resetAt, nowMs)}`}
                {row.rateLimit.bindingWindow && ` · ${row.rateLimit.bindingWindow} is binding`}
                {row.rateLimit.overageAvailable === false && " · no overage"}
              </p>
            )}
            {row.rateLimit?.status === "warning" && (
              <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                Approaching the allowance. Runs still go through, but the window is close to spent.
              </p>
            )}
            {row.breaker.state === "open" && (
              <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                {row.breaker.reason === "limit"
                  ? `Usage limit reached. Runs are paused, retrying ${row.breaker.openUntil ? formatUntil(row.breaker.openUntil, nowMs) : "after cooldown"}.`
                  : `Connection failures. Runs are paused, retrying ${row.breaker.openUntil ? formatUntil(row.breaker.openUntil, nowMs) : "after cooldown"}.`}
              </p>
            )}
          </div>
          <p className="text-xs tabular-nums text-foreground/50">
            {row.runs} run{row.runs === 1 ? "" : "s"}
            {row.failedRuns > 0 && `, ${row.failedRuns} failed`}
            {" · "}
            {formatTokens(row.promptTokens)} in / {formatTokens(row.completionTokens)} out
            {row.costReported && ` · ${formatPricePerMillion(row.costUsd)}`}
          </p>
        </div>
      ))}
    </section>
  );
}

/**
 * Summary callout above the three agent sections. Silent when every role's
 * provider already suits it, so a deliberate setup is not nagged at; when it
 * does appear it names the roles and offers the split Radulf's pipeline is
 * designed around: strong models on the once-per-card stages, the cheap seat
 * on the stage that runs every iteration.
 */
function RoleFitSummary({ misfitRoles, onApply }: { misfitRoles: readonly string[]; onApply: () => void }) {
  if (misfitRoles.length === 0) return null;
  return (
    <section aria-labelledby="role-fit-title" className={`${sectionCls} border-accent/25 bg-accent/[0.04]`}>
      <div>
        <h3 id="role-fit-title" className="font-medium">Suggested model split</h3>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-foreground/60">
          The planner and evaluator run once per card; the looper runs every iteration. Spending a
          strong model on the two that run once, and a local or low-cost model on the one that
          repeats, is the split this pipeline is built around. The planner even writes its plan for
          &ldquo;a much smaller local model&rdquo; to execute.
        </p>
        <p className="mt-2 text-xs text-foreground/45">
          Currently off that split: {misfitRoles.join(", ")}.
        </p>
      </div>
      <div>
        <button type="button" onClick={onApply} className={secondaryButtonCls}>
          Use Claude for planning and review, local for the loop
        </button>
        <p className="mt-2 text-xs text-foreground/40">
          Sets the scoping, planner and evaluator roles to your Anthropic subscription and the
          looper to your self-hosted endpoint, each on its default model. Adjust any of them afterwards.
        </p>
      </div>
    </section>
  );
}

/** Provider dropdown + model input with a datalist/chips loaded from the provider. */
function AgentSection({
  title,
  subtitle,
  demand,
  provider,
  model,
  onProvider,
  onModel,
  reasoningLevel,
  onReasoningLevel,
  saveFirst,
  datalistId,
  warnings,
}: {
  title: string;
  subtitle: string;
  /** What this stage of the pipeline demands of a model, and why, shown
   * above the pickers so the trade-off is visible at the point of choosing. */
  demand: string;
  provider: string;
  model: string;
  onProvider: (p: string) => void;
  onModel: (m: string) => void;
  reasoningLevel: string;
  onReasoningLevel: (r: string) => void;
  saveFirst: () => Promise<void>;
  datalistId: string;
  /** Advisory-only warnings rendered under the provider/model pickers, e.g. a
   * provider that does not suit the role, or the evaluator matching the loop's
   * provider+model. Never blocks saving. */
  warnings: string[];
}) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [status, setStatus] = useState("");

  // setState only happens in the promise callbacks, never synchronously,
  // so this is safe to call from the effect below.
  // `force` is only ever set by the "Load models" button — see the route.
  const load = useCallback((p: string, force = false, isLive: () => boolean = () => true) => {
    return api<{ models: ProviderModel[] }>(`/api/providers/${p}/models${force ? "?refresh=1" : ""}`)
      .then((r) => {
        if (!isLive()) return;
        setModels(r.models);
        setStatus(r.models.length > 0
          ? `✓ ${r.models.length} model${r.models.length === 1 ? "" : "s"}`
          : "No models found. Check your provider connection or enter a model id.");
      })
      .catch((e) => {
        if (!isLive()) return;
        setModels([]);
        setStatus(`✗ ${errorMessage(e)}`);
      });
  }, []);

  // Refresh the picker whenever the provider changes. Guard against a slow
  // provider's listing (e.g. openrouter's hundreds of models) landing after
  // the user has already switched this role to a different provider.
  useEffect(() => {
    let live = true;
    void load(provider, false, () => live);
    return () => { live = false; };
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
    <section aria-labelledby={`${datalistId}-title`} className={sectionCls}>
      <div>
        <h3 id={`${datalistId}-title`} className="font-medium">{title}</h3>
        <p className="mt-1 text-sm text-foreground/55">{subtitle}</p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-foreground/45">{demand}</p>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <label className="min-w-0 text-sm text-foreground/70">
          Provider
          <select
            value={provider}
            onChange={(e) => onProvider(e.target.value)}
            className={inputCls}
          >
            {/* Mock is testing-only (RADULF_MOCK_LLM=1) — listed only while this role already
                uses it, so a stored "mock" renders as itself; select it via PATCH /api/settings. */}
            {PROVIDERS.filter((p) => p.id !== "mock" || provider === "mock").map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="min-w-0 text-sm text-foreground/70 sm:col-span-2 sm:row-start-2">
          <label htmlFor={`${datalistId}-input`}>Model</label>
          <div className="flex gap-2">
            <input
              id={`${datalistId}-input`}
              aria-describedby={`${datalistId}-hint`}
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
                setStatus("Loading models…");
                saveFirst().then(() => load(provider, true)).catch(() => setStatus(""));
              }}
              title="Save settings and refresh available models"
              className={`${secondaryButtonCls} mt-2 shrink-0 whitespace-nowrap`}
            >
              Load models
            </button>
          </div>
          <p id={`${datalistId}-hint`} className="mt-2 text-xs leading-relaxed text-foreground/45">{MODEL_HINTS[provider] ?? "Enter a model id."}</p>
        </div>
        <label className="min-w-0 text-sm text-foreground/70 sm:col-start-2 sm:row-start-1">
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
      {warnings.map((warning) => (
        <p key={warning} className="rounded-lg border border-accent/15 bg-accent/5 px-3 py-2.5 text-xs leading-relaxed text-accent/85">{warning}</p>
      ))}
      {selectedModel && priceLabel(selectedModel) && (
        <p className="text-xs text-foreground/40">{priceLabel(selectedModel)}</p>
      )}
      {status && !status.startsWith("✓") && (
        <p role="status" className={`text-sm ${status.startsWith("✗") ? "text-red-400" : "text-foreground/40"}`}>
          {status}
        </p>
      )}
      <ModelChips
        models={models}
        value={model}
        onPick={onModel}
        titleFor={(m) => priceLabel(m, "/1M in", "/1M out", ", ") ? `${m.description || m.value} — ${priceLabel(m, "/1M in", "/1M out", ", ")}` : m.description || m.value}
        wrap={(chips) => (
          <details className="group border-t border-foreground/10 pt-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-xs text-foreground/55 hover:text-foreground">
              Browse {models.length} available model{models.length === 1 ? "" : "s"}
              <span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span>
            </summary>
            {chips}
          </details>
        )}
      />
    </section>
  );
}

/** Spec 27: the repository's gate command, edited in place on its row. */
function GateCommandField({ repo, onChange }: { repo: Repo; onChange: () => void }) {
  const [value, setValue] = useState(repo.gateCommand ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = value.trim() !== (repo.gateCommand ?? "");

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/repos/${repo.id}`, { method: "PATCH", json: { gateCommand: value.trim() } });
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 grow items-center gap-2 text-xs text-foreground/60">
        <span className="shrink-0">Gate command</span>
        <input
          aria-label={`Gate command for ${repo.name}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="None. Runs before each evaluation, e.g. make check"
          className={`${inputCls} mt-0 font-mono text-xs`}
        />
      </label>
      {dirty && (
        <button onClick={() => void save()} disabled={saving} className="min-h-9 rounded border border-foreground/15 px-2 text-xs hover:bg-foreground/5">
          {saving ? "Saving…" : "Save gate"}
        </button>
      )}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function ReposSection({ repos, onChange }: { repos: Repo[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [gate, setGate] = useState("");
  const [error, setError] = useState("");
  // Shown on the row it belongs to — e.g. the conflict when a repo still has
  // running work — rather than below the add form.
  const [removeError, setRemoveError] = useState<{ repoId: string; message: string } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Typing an absolute path stays available: the browser is confined to one
  // root, and a repo kept outside it has to be reachable some other way.
  const [typePath, setTypePath] = useState(false);

  function pickFolder(picked: string) {
    setPath(picked);
    setBrowsing(false);
    if (!name.trim()) setName(picked.split("/").pop() ?? "");
  }

  // Errors propagate: the browser reports them through onError.
  async function createRepo(parentPath: string, repoName: string) {
    setError("");
    await api("/api/repos/init", { json: { parentPath, name: repoName } });
    setBrowsing(false);
    onChange();
  }

  async function cloneRepo(url: string) {
    setError("");
    await api("/api/repos/clone", { json: { url } });
    setBrowsing(false);
    onChange();
  }

  async function add() {
    setError("");
    try {
      await api("/api/repos", { json: { name, path, defaultBranch: branch, gateCommand: gate } });
      setName("");
      setPath("");
      setBranch("");
      setGate("");
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section id="repos" className={sectionCls}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Connected repositories</h3>
        <span className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-foreground/55">{repos.length}</span>
      </div>
      {repos.length === 0 && <p className="text-sm text-foreground/55">Add your first repository to give your agents a place to work.</p>}
      <div className="divide-y divide-foreground/10">
        {repos.map((r) => (
          <div key={r.id} className="flex min-w-0 items-center gap-4 py-4 first:pt-0 last:pb-0">
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{r.name}</span>
                <span className="rounded border border-foreground/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground/50">{r.defaultBranch}</span>
              </div>
              <p title={r.path} className="mt-1.5 truncate font-mono text-xs text-foreground/45">{r.path}</p>
              <GateCommandField key={r.gateCommand ?? ""} repo={r} onChange={onChange} />
              {removeError?.repoId === r.id && <p role="alert" className="mt-1.5 text-xs text-red-400">{removeError.message}</p>}
            </div>
            <button
              onClick={() => {
                if (!confirm(`Remove "${r.name}"? Its tasks and history will be deleted.`)) return;
                setRemoveError(null);
                api(`/api/repos/${r.id}`, { method: "DELETE" })
                  .then(onChange)
                  .catch((cause) => setRemoveError({ repoId: r.id, message: errorMessage(cause) }));
              }}
              className="min-h-11 px-2 text-xs text-red-400/70 hover:text-red-400"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <details open={repos.length === 0 ? true : undefined} className="group border-t border-foreground/10 pt-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground/75 hover:text-foreground">
          Add repository
          <span aria-hidden="true" className="text-lg transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2">
          <label className="text-sm text-foreground/70">
            Repository name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              className={inputCls}
            />
          </label>
          <label className="text-sm text-foreground/70">
            Default branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Auto-detect" className={inputCls} />
          </label>
          <label className="text-sm text-foreground/70 sm:col-span-2">
            Gate command
            <input value={gate} onChange={(e) => setGate(e.target.value)} placeholder="Optional, e.g. make check" className={`${inputCls} font-mono`} />
          </label>
          <div className="min-w-0 text-sm text-foreground/70 sm:col-span-2">
            <label htmlFor={typePath ? "repo-path" : "repo-folder"}>Repository folder</label>
            {typePath ? (
              <input
                id="repo-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/repo"
                className={`${inputCls} font-mono`}
              />
            ) : (
              <>
                <button
                  id="repo-folder"
                  type="button"
                  onClick={() => setBrowsing((open) => !open)}
                  aria-label="Choose repository folder"
                  aria-expanded={browsing}
                  title={path || undefined}
                  className={`${inputCls} flex items-center gap-2 text-left hover:bg-foreground/10`}
                >
                  <span aria-hidden className="text-foreground/50">↳</span>
                  <span className={`min-w-0 truncate ${path ? "font-mono" : "text-foreground/40"}`}>
                    {path || "Browse folders…"}
                  </span>
                </button>
                {browsing && (
                  <div className="mt-2">
                    <FolderBrowser onPick={pickFolder} onCreate={createRepo} onClone={cloneRepo} onError={setError} />
                  </div>
                )}
              </>
            )}
          </div>
          <button
            onClick={add}
            disabled={!name.trim() || !path.trim()}
            className={`${secondaryButtonCls} justify-self-start`}
          >
            Add repository
          </button>
        </div>
        {!typePath && (
          <button
            type="button"
            onClick={() => setTypePath(true)}
            className="mt-3 text-xs text-foreground/50 underline underline-offset-4 hover:text-foreground/80"
          >
            Type the path instead
          </button>
        )}
        <p className="mt-2 text-xs text-foreground/45">The folder picker opens on the machine running Radulf.</p>
      </details>
      {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
    </section>
  );
}
