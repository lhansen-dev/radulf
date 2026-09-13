"use client";

import { useSyncExternalStore, type ReactNode } from "react";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", group: "Workspace", description: "Appearance, notifications, and the little things that make Radulf yours.", icon: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0" },
  { id: "repos", label: "Repositories", group: "Workspace", description: "Choose where your agents work and connect GitHub for pull requests.", icon: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" },
  { id: "models", label: "Agents & models", group: "Agents", description: "Give each stage of your workflow the right model and reasoning effort.", icon: "M8 3v3m8-3v3M5 6h14v14H5V6Zm3 5h.01M16 11h.01M9 16h6M2 10v6m20-6v6" },
  { id: "agents", label: "Providers & keys", group: "Agents", description: "Connect your subscriptions, local models, and API services.", icon: "m14 8 2 2m-9 4-4 4v3h3v-3h3l3-3M21 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0" },
  { id: "defaults", label: "Run limits", group: "Agents", description: "Set the time and iteration budgets for your agents.", icon: "M12 8v4l3 2M9 2h6M12 2v3m6 1 2-2M21 13a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
  { id: "templates", label: "Prompt templates", group: "Agents", description: "Shape the instructions your agents use for future runs.", icon: "M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h5" },
  { id: "sandbox", label: "Sandbox", group: "System", description: "Control how agents access your machine and the network.", icon: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6" },
  { id: "maintenance", label: "Maintenance", group: "System", description: "Manage stored history and keep your workspace tidy.", icon: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

const SECTION_ALIASES: Record<string, SettingsSection> = {
  appearance: "general",
  notifications: "general",
  github: "repos",
  "planner-defaults": "defaults",
  "evaluator-defaults": "defaults",
};

function subscribeToSection(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function currentSection(): SettingsSection {
  const hash = window.location.hash.slice(1);
  return SETTINGS_SECTIONS.find((section) => section.id === hash)?.id
    ?? (Object.hasOwn(SECTION_ALIASES, hash) ? SECTION_ALIASES[hash] : "general");
}

export function useSettingsSection() {
  return useSyncExternalStore(subscribeToSection, currentSection, () => "general" as const);
}

export function SettingsNav({ active }: { active: SettingsSection }) {
  return (
    <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto pb-2 lg:sticky lg:top-32 lg:flex-col lg:gap-6 lg:overflow-visible lg:pb-0">
      {["Workspace", "Agents", "System"].map((group) => (
        <div key={group} className="flex shrink-0 gap-1 lg:block">
          <p className="mb-2 hidden px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/40 lg:block">{group}</p>
          <div className="flex gap-1 lg:flex-col">
            {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={active === section.id ? "location" : undefined}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  if (window.location.hash !== `#${section.id}`) {
                    window.history.pushState(null, "", `#${section.id}`);
                    window.dispatchEvent(new HashChangeEvent("hashchange"));
                  }
                  window.scrollTo({ top: 0, behavior: "instant" });
                }}
                className={`touch-target flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors ${active === section.id
                    ? "bg-accent/10 font-medium text-accent"
                    : "text-foreground/60 hover:bg-foreground/5 hover:text-foreground"
                  }`}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px] shrink-0">
                  <path d={section.icon} />
                </svg>
                {section.label}
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Keep editors mounted so switching sections preserves drafts and open details. */
export function SettingsPanel({ active, section, children }: {
  active: SettingsSection;
  section: SettingsSection;
  children: ReactNode;
}) {
  return <div hidden={active !== section}>{children}</div>;
}

export const sectionCls = "flex min-w-0 scroll-mt-32 flex-col gap-5 rounded-xl border border-foreground/10 bg-surface p-5 sm:p-6";
export const inputCls = "mt-2 min-w-0 w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/35 transition-colors hover:border-foreground/25 focus:border-accent";
export const secondaryButtonCls = "rounded-lg border border-foreground/15 bg-foreground/[0.03] px-3.5 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.07] disabled:opacity-40";

export function ToggleRow({ title, description, checked, onChange }: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6 py-1">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        {description && <span className="mt-1 block text-xs leading-relaxed text-foreground/55">{description}</span>}
      </span>
      <span className="relative shrink-0">
        <input type="checkbox" aria-label={title} checked={checked} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" />
        <span aria-hidden="true" className="block h-6 w-10 rounded-full bg-foreground/20 transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-accent" />
        <span aria-hidden="true" className="pointer-events-none absolute top-1 left-1 size-4 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

const THEMES = [
  ["default", "Default", "#0b0d10", "#d7dce2", "#fbbf24"],
  ["default-light", "Default Light", "#f7f8fa", "#1a1d23", "#d97706"],
  ["solarized-dark", "Solarized Dark", "#002b36", "#93a1a1", "#b58900"],
  ["solarized-light", "Solarized Light", "#fdf6e3", "#657b83", "#b58900"],
  ["tokyo-night", "Tokyo Night", "#1a1b26", "#a9b1d6", "#7aa2f7"],
  ["tokyo-day", "Tokyo Day", "#e1e2e7", "#565a6e", "#34548a"],
  ["nord", "Nord", "#2e3440", "#d8dee9", "#88c0d0"],
  ["nord-light", "Nord Light", "#eceff4", "#2e3440", "#5e81ac"],
  ["gruvbox-dark", "Gruvbox Dark", "#282828", "#ebdbb2", "#fabd2f"],
  ["gruvbox-light", "Gruvbox Light", "#fbf1c7", "#3c3836", "#d79921"],
] as const;

export function ThemePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <fieldset>
      <legend className="sr-only">Color theme</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 lg:grid-cols-3 xl:grid-cols-5">
        {THEMES.map(([id, label, background, foreground, accent]) => (
          <label key={id} className="relative min-w-0 cursor-pointer">
            <input type="radio" name="theme" value={id} checked={value === id} onChange={() => onChange(id)} className="peer sr-only" />
            <span className="flex h-full flex-col gap-2.5 rounded-lg border border-foreground/10 p-2 transition-colors peer-checked:border-accent peer-checked:bg-accent/5 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent hover:border-foreground/30">
              <span aria-hidden="true" className="flex h-14 overflow-hidden rounded border border-foreground/10" style={{ background, color: foreground }}>
                <span className="flex w-5 flex-col items-center gap-1.5 border-r border-current/10 pt-2">
                  <span className="size-2 rounded-sm" style={{ background: accent }} />
                  <span className="size-1 rounded-full bg-current opacity-30" />
                  <span className="size-1 rounded-full bg-current opacity-30" />
                </span>
                <span className="flex flex-1 flex-col gap-1.5 p-2">
                  <span className="h-1 w-2/3 rounded-full bg-current opacity-70" />
                  <span className="h-1 w-full rounded-full bg-current opacity-20" />
                  <span className="mt-auto h-2 w-1/2 rounded-sm" style={{ background: accent }} />
                </span>
              </span>
              <span className="text-center text-[11px] font-medium leading-snug text-foreground/75">{label}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
