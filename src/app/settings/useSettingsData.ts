"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "../ui/api";

export type Settings = {
  plannerProvider: string;
  plannerModel: string;
  plannerReasoningLevel: string;
  loopProvider: string;
  loopModel: string;
  loopReasoningLevel: string;
  evaluatorProvider: string;
  evaluatorModel: string;
  evaluatorReasoningLevel: string;
  plannerTimeoutMinutes: number;
  folderBrowserRoot: string;
  omlxBaseUrl: string;
  omlxApiKey: string;
  openrouterApiKey: string;
  braveApiKey: string;
  defaultMaxIterations: number;
  defaultTimeoutMinutes: number;
  iterationHardTimeoutMinutes: number;
  evaluatorTimeoutMinutes: number;
  stallTimeoutSeconds: number;
  minimalToolset: boolean;
  sandboxEnabled: boolean;
  sandboxNetworkAllowlist: string;
  sandboxWeakerIsolationForGoTls: boolean;
  notificationsEnabled: boolean;
  attentionStaleMinutes: number;
  alertWebhookUrl: string;
  soundEnabled: boolean;
  theme: string;
  plannerPromptTemplate: string;
  evaluatorPromptTemplate: string;
  improvePromptTemplate: string;
};

export type PromptTemplateSettings = Pick<
  Settings,
  | "plannerPromptTemplate"
  | "evaluatorPromptTemplate"
  | "improvePromptTemplate"
>;

/** Settings/repository loading and settings persistence state. */
export function useSettingsData() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [persisted, setPersisted] = useState<Settings | null>(null);
  const [error, setError] = useState("");

  // Repository changes must not replace unsaved settings in another section.
  const refetch = useCallback(() => {
    api<Repo[]>("/api/repos").then(setRepos).catch(() => { });
  }, []);
  useEffect(refetch, [refetch]);
  useEffect(() => {
    api<Settings>("/api/settings").then((loaded) => {
      setSettings(loaded);
      setPersisted(loaded);
    }).catch((cause) => setError(String(cause)));
  }, []);

  const dirty = settings !== null && persisted !== null && JSON.stringify(settings) !== JSON.stringify(persisted);

  async function save() {
    if (!settings) return;
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const updated = await api<Settings>("/api/settings", {
        method: "PATCH",
        json: settings,
      });
      // Adopt returned values (including masked keys), keeping only edits made
      // after this save started.
      setSettings((current) => current && current !== settings ? {
        ...updated,
        ...Object.fromEntries(Object.entries(current).filter(
          ([key, value]) => value !== settings[key as keyof Settings],
        )),
      } : updated);
      setPersisted(updated);
      document.documentElement.dataset.theme = updated.theme;
      setSaved(true);
      setTimeout(() => setSaved(false), 5000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSaving(false);
    }
  }

  return { settings, setSettings, repos, saved, saving, dirty, error, setError, refetch, save };
}
