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
  omlxBaseUrl: string;
  omlxApiKey: string;
  openrouterApiKey: string;
  braveApiKey: string;
  defaultMaxIterations: number;
  defaultTimeoutMinutes: number;
  iterationHardTimeoutMinutes: number;
  stallTimeoutSeconds: number;
  minimalToolset: boolean;
  sandboxEnabled: boolean;
  sandboxNetworkAllowlist: string;
  sandboxWeakerIsolationForGoTls: boolean;
  notificationsEnabled: boolean;
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
  const [error, setError] = useState("");

  const refetch = useCallback(() => {
    api<Settings>("/api/settings").then(setSettings).catch((cause) => setError(String(cause)));
    api<Repo[]>("/api/repos").then(setRepos).catch(() => {});
  }, []);
  useEffect(refetch, [refetch]);

  async function save() {
    if (!settings) return;
    setError("");
    setSaved(false);
    try {
      const updated = await api<Settings>("/api/settings", {
        method: "PATCH",
        json: settings,
      });
      setSettings(updated);
      document.documentElement.dataset.theme = updated.theme;
      setSaved(true);
      setTimeout(() => setSaved(false), 5000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  return { settings, setSettings, repos, saved, error, setError, refetch, save };
}
