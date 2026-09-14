"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude subscription)",
  chatgpt: "ChatGPT (Codex subscription)",
  copilot: "GitHub Copilot (subscription)",
  omlx: "oMLX (local)",
  openrouter: "OpenRouter",
};

export const ROLES = ["planner", "loop", "evaluator"] as const;
export type Role = (typeof ROLES)[number];
type ModelOption = { value: string; displayName: string };
export type RoleModels = Record<Role, string>;
export const EMPTY_ROLE_MODELS: RoleModels = { planner: "", loop: "", evaluator: "" };
const ROLE_LABELS: Record<Role, string> = { planner: "Planner model", loop: "Loop model", evaluator: "Evaluator model" };

/** Each role's configured provider and the models it serves, for the pickers. */
export function useRoleModelOptions() {
  const [providers, setProviders] = useState<RoleModels>(EMPTY_ROLE_MODELS);
  const [models, setModels] = useState<Record<Role, ModelOption[]>>({ planner: [], loop: [], evaluator: [] });
  useEffect(() => {
    api<Record<`${Role}Provider`, string>>("/api/settings")
      .then(async (settings) => {
        const next = { planner: settings.plannerProvider, loop: settings.loopProvider, evaluator: settings.evaluatorProvider };
        setProviders(next);
        const load = (provider: string) =>
          api<{ models: ModelOption[] }>(`/api/providers/${provider}/models`).then((r) => r.models).catch(() => []);
        const [planner, loop, evaluator] = await Promise.all(ROLES.map((role) => load(next[role])));
        setModels({ planner, loop, evaluator });
      }).catch(() => {});
  }, []);
  return { providers, models };
}

/** A repo's branch list; empty while loading or on failure. */
export function useBranches(repoId: string, onLoaded?: (branches: string[]) => void) {
  const [branches, setBranches] = useState<string[]>([]);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });
  useEffect(() => {
    if (!repoId) return;
    const apply = (list: string[]) => { setBranches(list); onLoadedRef.current?.(list); };
    fetch(`/api/repos/${repoId}/branches`)
      .then(async (res) => {
        const data = res.ok ? await res.json() : [];
        apply(Array.isArray(data) ? (data as string[]) : []);
      })
      .catch(() => apply([]));
  }, [repoId]);
  return [branches, setBranches] as const;
}

export function RoleModelSelects({ providers, models, values, onChange, idPrefix = "" }: {
  providers: RoleModels;
  models: Record<Role, ModelOption[]>;
  values: RoleModels;
  onChange: (values: RoleModels) => void;
  idPrefix?: string;
}) {
  return ROLES.map((role) => (
    <ModelSelect
      key={role}
      label={ROLE_LABELS[role]}
      providerId={providers[role]}
      value={values[role]}
      setValue={(value) => onChange({ ...values, [role]: value })}
      models={models[role]}
      inputId={`${idPrefix}${role}-model-input`}
      datalistId={`${idPrefix}${role}-models`}
    />
  ));
}

function ModelSelect({ label, providerId, value, setValue, models, inputId, datalistId }: { label: string; providerId: string; value: string; setValue: (value: string) => void; models: ModelOption[]; inputId: string; datalistId: string }) {
  return (
    <div>
      <label htmlFor={inputId} className="block text-sm text-foreground/70">{label}</label>
      <p className="mt-0.5 text-xs text-foreground/40">Provider: {PROVIDER_LABELS[providerId] ?? providerId}</p>
      <input
        id={inputId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Default from settings"
        className="mt-1 w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3"
        list={datalistId}
      />
      <datalist id={datalistId}>
        {models.map((model) => <option key={model.value} value={model.value}>{model.displayName}</option>)}
      </datalist>
      {models.length > 0 && models.length <= 30 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {models.map((model) => (
            <button
              key={model.value}
              type="button"
              onClick={() => setValue(model.value)}
              className={`text-xs rounded px-2 py-1 border ${value === model.value ? "border-amber-500 text-amber-400" : "border-foreground/10 text-foreground/60 hover:text-foreground"}`}
            >
              {model.displayName}
            </button>
          ))}
        </div>
      )}
      {models.length > 30 && <p className="mt-1 text-xs text-foreground/40">Type in the model field to search the list.</p>}
    </div>
  );
}

/** Bottom-sheet / centered modal with a focus trap, Escape to close, body
 * scroll lock, and focus restored to the invoker on unmount. */
export function DialogShell({ titleId, title, closeLabel, onRequestClose, footer, children }: {
  titleId: string;
  title: string;
  closeLabel: string;
  onRequestClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestCloseRef = useRef(onRequestClose);
  useEffect(() => { requestCloseRef.current = onRequestClose; });

  useEffect(() => {
    const invoker = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary') ?? []);
    focusable()[0]?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); requestCloseRef.current(); }
      if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); invoker?.focus(); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && onRequestClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[min(92dvh,800px)] w-full flex-col rounded-t-2xl border border-foreground/10 bg-surface shadow-2xl sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center border-b border-foreground/10 px-4 py-3">
          <h2 id={titleId} className="grow text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onRequestClose} aria-label={closeLabel} className="grid size-11 place-items-center rounded-lg text-xl text-foreground/55 hover:bg-foreground/[0.06]">×</button>
        </header>
        <div className="min-h-0 grow space-y-4 overflow-y-auto p-4 sm:p-5">{children}</div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-foreground/10 bg-surface p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:p-4">{footer}</footer>
      </div>
    </div>
  );
}
